import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const key = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();
export const supabase = url && key ? createClient(url, key, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null;

export function fromParticipant(row) {
  if (!row) return null;
  return {
    id: row.id, userId: row.user_id, name: row.name, university: row.university_name,
    winnerStatus: row.winner_status || 'Not Announced',
    registrationDate: row.created_at, reg: row.reg, email: row.email,
    phone: row.phone, department: row.department, semester: row.semester, batch: row.batch,
    type: row.participation_type, team: row.team || '', ...(row.member || {}), teamDetails: row.member || {},
    payment: row.payment_status, paymentRef: row.payment_ref, paymentProof: row.payment_proof_path,
    paymentComment: row.payment_comment, project: row.project || '', github: row.github_url || '',
    live: row.live_url || '', drive: row.drive_url || '', submittedAt: row.submitted_at,
    competitionId: row.competition_id, description: row.project_description || '',
    technologies: row.technologies || '', apis: row.api_details || '',
    startedAt: row.started_at, evaluation: row.evaluation || {}, feedback: row.feedback || '',
    evaluated: row.evaluated,
  };
}

export function isCompetitionRegistrationOpen(competition, now = Date.now()) {
  if (!competition || competition.registrationOpen === false || !['upcoming', 'active'].includes(competition.status)) return false;
  if (!competition.registrationDeadline) return true;
  const deadline = new Date(competition.registrationDeadline).getTime();
  return Number.isFinite(deadline) && deadline >= now;
}

export function toParticipant(values, userId) {
  const member = values.type === 'Team' ? {
    memberName: values.memberName, memberReg: values.memberReg,
    memberEmail: values.memberEmail, memberPhone: values.memberPhone,
  } : {};
  return {
    user_id: userId, name: values.name, reg: values.reg, email: values.email,
    phone: values.phone, department: values.department, semester: values.semester,
    batch: values.batch, participation_type: values.type, team: values.team || null,
    member,
  };
}

export async function loadCompetition(user) {
  if (!supabase) return null;
  const profileResult = user
    ? await supabase.from('profiles').select('id,full_name,role').eq('id', user.id).maybeSingle()
    : { data: null, error: null };
  if (profileResult.error) throw profileResult.error;
  const role = profileResult.data?.role || 'participant';
  // Participant sessions may not have SELECT access to the private settings table.
  // The public view is intended for the website and also contains the public config.
  const settingsSource = role === 'admin' ? 'competition_settings' : 'public_competition_settings';
  const settingsResult = await supabase.from(settingsSource).select('*').eq('id', 1).maybeSingle();
  if (settingsResult.error) throw settingsResult.error;
  if (!settingsResult.data) {
    throw new Error(`No id=1 settings row is visible in ${settingsSource} for this account. Check Supabase SELECT policies/view.`);
  }
  const rosterResult = user && role === 'admin'
    ? await supabase.from('participants').select('*').order('created_at', { ascending: false })
    : user
    ? await supabase.from('participants').select('*').eq('user_id', user.id).order('created_at', { ascending: false })
      : { data: [], error: null };
  const registrationsResult = user
    ? role === 'admin'
      ? await supabase.from('competition_registrations').select('competition_id,user_id,participation_type,team_name,member_details')
      : await supabase.from('competition_registrations').select('competition_id,user_id,participation_type,team_name,member_details').eq('user_id', user.id)
    : { data: [], error: null };
  const resultsResult = await supabase.rpc('published_competition_results');
  const competitionsResult = role === 'admin'
    ? await supabase.from('competitions').select('*').order('created_at', { ascending: false })
    : await supabase.from('public_competition_catalog').select('*').order('starts_at', { ascending: true });
  const durationResult = role === 'admin'
    ? { data: [], error: null }
    : await supabase.from('public_competition_durations').select('id,duration_minutes');
  const rulesResult = role === 'admin'
    ? await supabase.from('competition_rules').select('id,competition_id,title,content,sort_order,created_at,updated_at').order('sort_order').order('created_at')
    : { data: [], error: null };
  if (rosterResult.error) throw rosterResult.error;
  if (registrationsResult.error) throw registrationsResult.error;
  if (resultsResult.error) throw resultsResult.error;
  if (competitionsResult.error) throw competitionsResult.error;
  if (durationResult.error) throw durationResult.error;
  if (rulesResult.error) throw rulesResult.error;
  const profilesResult = role === 'admin'
    ? await supabase.from('profiles').select('id,full_name,role,created_at').order('created_at', { ascending: true })
    : { data: [], error: null };
  if (profilesResult.error) throw profilesResult.error;
  const registrations = new Map((registrationsResult.data || []).map(row => [`${row.competition_id}:${row.user_id}`, row]));
  const participants = (rosterResult.data || []).map(row => {
    const registration = registrations.get(`${row.competition_id}:${row.user_id}`);
    return fromParticipant({ ...row,
      participation_type: registration?.participation_type || row.participation_type,
      team: registration?.team_name || row.team,
      member: registration?.member_details && Object.keys(registration.member_details).length ? registration.member_details : row.member,
    });
  });
  const s = settingsResult.data;
  return {
    role,
    account: user ? { id: user.id, email: user.email, name: profileResult.data?.full_name || user.user_metadata?.full_name || user.email, role } : null,
    participants,
    profiles: profilesResult.data || [],
    results: (resultsResult.data || []).map((row) => ({ ...fromParticipant(row), evaluated: true })),
    competitions: (competitionsResult.data || []).map(row => ({
      ...fromCompetition(row),
      durationMinutes: Number(role === 'admin' ? row.duration_minutes : (durationResult.data || []).find(item => item.id === row.id)?.duration_minutes) || 120,
      ruleItems: (rulesResult.data || []).filter(rule => rule.competition_id === row.id),
    })),
    config: {
      title: s.title, duration: s.duration_minutes, mode: s.mode, task: s.task,
      registrationOpen: s.registration_open, paymentEnabled: s.payment_enabled,
      paymentAmount: s.payment_amount || '', paymentInstructions: s.payment_instructions || '',
      driveUploadUrl: s.drive_upload_url || '', driveEnabled: s.drive_enabled,
      resultsPublished: s.results_published,
    },
  };
}

function fromCompetition(row) {
  return {
    id: row.id, title: row.title, shortDescription: row.short_description, durationMinutes: Number(row.duration_minutes) || 120,
    description: row.detailed_description, university: row.university_name, department: row.department,
    rules: row.rules_html, task: row.task_html || row.task, startsAt: row.starts_at,
    ruleItems: row.rules || [],
    submissionInstructions: row.submission_instructions || '', requiredTechnologies: row.required_technologies || '',
    endsAt: row.ends_at, registrationDeadline: row.registration_deadline, status: row.status,
    registrationOpen: row.registration_open !== false,
    driveUploadUrl: row.drive_upload_url || '', driveEnabled: row.drive_enabled,
    resultsAnnounced: row.results_announced,
    winners: row.winners || [], announcements: row.announcements || [],
  };
}

export async function loadCompetitionDetails(id) {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('authorized_competition_details', { p_competition_id: id });
  if (error) throw error;
  return fromCompetition(data);
}

export async function loadCompetitionRules(competitionId) {
  if (!supabase) return [];
  const { data, error } = await supabase.from('competition_rules')
    .select('id,competition_id,title,content,sort_order,created_at,updated_at')
    .eq('competition_id', competitionId).order('sort_order').order('created_at');
  if (error) throw error;
  return data || [];
}

export async function createCompetitionRule({ competitionId, title, content, sortOrder = 0 }) {
  if (!supabase) throw new Error('Connect Supabase to manage competition rules.');
  const { data, error } = await supabase.rpc('admin_create_competition_rule', {
    p_competition_id: competitionId, p_title: title, p_content: content, p_sort_order: sortOrder,
  });
  if (error) throw error;
  return data;
}

export async function updateCompetitionRule({ id, title, content, sortOrder = 0 }) {
  if (!supabase) throw new Error('Connect Supabase to manage competition rules.');
  const { data, error } = await supabase.rpc('admin_update_competition_rule', {
    p_id: id, p_title: title, p_content: content, p_sort_order: sortOrder,
  });
  if (error) throw error;
  return data;
}

export async function deleteCompetitionRule(id) {
  if (!supabase) throw new Error('Connect Supabase to manage competition rules.');
  const { error } = await supabase.rpc('admin_delete_competition_rule', { p_id: id });
  if (error) throw error;
}

function toCompetition(item, userId) {
  return {
    title: item.title, short_description: item.shortDescription || '', duration_minutes: Math.min(240, Math.max(1, Number(item.durationMinutes) || 120)),
    detailed_description: item.description || '', university_name: item.university || '',
    department: item.department || '', rules_html: item.rules || '', task_html: item.task || '',
    task: item.task || '', submission_instructions: item.submissionInstructions || '', required_technologies: item.requiredTechnologies || '',
    starts_at: item.startsAt || null, ends_at: item.endsAt || null,
    registration_deadline: item.registrationDeadline || null, status: item.status || 'upcoming',
    registration_open: item.registrationOpen !== false,
    drive_upload_url: item.driveUploadUrl || null, drive_enabled: !!item.driveEnabled,
    results_announced: !!item.resultsAnnounced, created_by: userId || null,
    updated_at: new Date().toISOString(),
  };
}

export async function saveCompetition(item, userId) {
  if (!supabase) return item;
  const payload = toCompetition(item, userId);
  const query = item.id && !item.id.startsWith('comp-')
    ? supabase.from('competitions').update(payload).eq('id', item.id).select().single()
    : supabase.from('competitions').insert(payload).select().single();
  const { data, error } = await query;
  if (error) throw error;
  return fromCompetition(data);
}

export async function deleteCompetition(id) {
  if (!supabase) return;
  const { error } = await supabase.from('competitions').delete().eq('id', id);
  if (error) throw error;
}

export async function registerParticipant(values) {
  if (!supabase) return null;
  const { password, confirm, ...profile } = values;
  const { data, error } = await supabase.auth.signUp({
    email: values.email,
    password,
    options: { data: values.competitionId ? { ...profile, full_name: values.name, competition_id: values.competitionId } : { full_name: values.name } },
  });
  if (error) throw error;
  if (!data.session) return { confirmationRequired: true };
  if (!values.competitionId) return { user: data.user, accountOnly: true };
  const { error: participantError } = await supabase.from('participants').select('id').eq('user_id', data.user.id).single();
  if (participantError) throw participantError;
  return { user: data.user };
}

export async function registerForCompetition(values) {
  if (!supabase) return null;
  const { data: { user }, error: userError } = await supabase.auth.getUser();
  if (userError) throw userError;
  if (!user) throw new Error('Log in before joining another competition.');
  const { data, error } = await supabase.rpc('register_for_competition', {
    p_competition_id: values.competitionId,
    p_registration_number: values.reg,
    p_university_name: values.university,
    p_department: values.department,
    p_semester: values.semester,
    p_batch: values.batch,
    p_participation_type: values.type,
    p_team_name: values.team || null,
    p_member_details: values.type === 'Team' ? {
      memberName: values.memberName, memberReg: values.memberReg,
      memberEmail: values.memberEmail, memberPhone: values.memberPhone,
    } : {},
  });
  if (error) throw error;
  return user;
}

export async function removeCompetitionParticipant(id) {
  if (!supabase) return;
  const { error } = await supabase.rpc('admin_remove_competition_participant', { p_id: id });
  if (error) throw error;
}

export async function setProfileRole(userId, role) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.rpc('admin_set_profile_role', { p_user_id: userId, p_role: role });
  if (error) throw error;
}

export async function loadAdminAccounts() {
  if (!supabase) return [];
  const { data, error } = await supabase.functions.invoke('admin-user-management', { body: { action: 'list' } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data?.users || [];
}

export async function updateAdminAccount(userId, patch) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('admin-user-management', { body: { action: 'update', userId, ...patch } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  return data?.user;
}

export async function loadAdminAnnouncements() {
  if (!supabase) return [];
  const { data, error } = await supabase.from('competition_announcements')
    .select('id,competition_id,subject,body,created_at,visible_to_participants').order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function setAnnouncementVisibility(id, visible) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.rpc('admin_set_announcement_visibility', { p_id: id, p_visible: visible });
  if (error) throw error;
}


export async function saveCompetitionWinner({ competitionId, participantId, placement }) {
  if (!supabase) return;
  const { data: participant, error: participantError } = await supabase.from('participants').select('user_id,competition_id').eq('id', participantId).single();
  if (participantError) throw participantError;
  const { data: registration, error: registrationError } = await supabase.from('competition_registrations').select('id').eq('competition_id', competitionId).eq('user_id', participant.user_id).maybeSingle();
  if (registrationError) throw registrationError;
  if (!registration) throw new Error('This participant has no competition registration. Run the latest database migration.');
  const { error } = await supabase.from('competition_winners').upsert({ competition_id: competitionId, registration_id: registration.id, placement: Number(placement), announced_at: new Date().toISOString() }, { onConflict: 'competition_id,placement' });
  if (error) throw error;
}

export async function deleteCompetitionWinner({ competitionId, placement }) {
  if (!supabase) return;
  const { error } = await supabase.from('competition_winners').delete().eq('competition_id', competitionId).eq('placement', Number(placement));
  if (error) throw error;
}

export async function loadPublicCompetitionWinners(competitionId) {
  if (!supabase || !competitionId) return [];
  const { data, error } = await supabase.rpc('public_competition_winners', { p_competition_id: competitionId });
  if (error) throw error;
  return data || [];
}

export async function saveParticipant(id, participant, isAdmin, patch = {}) {
  if (!supabase || !participant) return;
  if (!isAdmin && patch.startedAt) {
    const { data, error } = await supabase.rpc('start_competition_timer', { p_id: id });
    if (error) throw error;
    return { started_at: data };
  }
  if (!isAdmin && patch.saveDraft) {
    const { data, error } = await supabase.rpc('save_competition_submission_draft', {
      p_id:id, p_project:participant.project || '', p_description:participant.description || '',
      p_technologies:participant.technologies || '', p_api_details:participant.apis || '',
      p_github:participant.github || '', p_live:participant.live || '', p_drive:participant.drive || '',
    });
    if (error) throw error;
    return data;
  }
  if (!isAdmin && patch.submittedAt) {
    const { data, error } = await supabase.rpc('submit_competition_project', {
      p_id: id, p_project: participant.project, p_description: participant.description || '',
      p_technologies: participant.technologies || '', p_api_details: participant.apis || '',
      p_github: participant.github, p_live: participant.live, p_drive: participant.drive,
    });
    if (error) throw error;
    return data;
  }
  const base = {
    phone: participant.phone, payment_ref: participant.paymentRef || null,
    payment_proof_path: participant.paymentProof || null, updated_at: new Date().toISOString(),
  };
  if (isAdmin) {
    const { error } = await supabase.rpc('admin_update_participant', {
      p_id: id,
      p_patch: {
        ...base, payment_status: participant.payment, payment_comment: participant.paymentComment || null,
        winner_status: participant.winnerStatus || 'Not Announced',
        evaluation: participant.evaluation || {}, feedback: participant.feedback || '', evaluated: !!participant.evaluated,
      },
    });
    if (error) throw error;
  } else {
    const { error } = await supabase.from('participants').update(base).eq('id', id);
    if (error) throw error;
  }
}

export async function requestPasswordReset(email, redirectTo) {
  if (!supabase) throw new Error('Password reset email is unavailable in local demo mode.');
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) throw error;
}

export async function updatePassword(password) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

export async function updateAccountEmail(email) {
  if (!supabase) throw new Error('Email changes need a connected Supabase project.');
  const { data, error } = await supabase.auth.updateUser({ email });
  if (error) throw error;
  return data;
}

export async function saveSettings(config) {
  if (!supabase) return;
  const { error } = await supabase.from('competition_settings').update({
    title: config.title, duration_minutes: config.duration, mode: config.mode, task: config.task,
    registration_open: config.registrationOpen, payment_enabled: config.paymentEnabled,
    payment_amount: config.paymentAmount || null, payment_instructions: config.paymentInstructions || null,
    drive_upload_url: config.driveUploadUrl || null, drive_enabled: !!config.driveEnabled,
    results_published: config.resultsPublished, updated_at: new Date().toISOString(),
  }).eq('id', 1);
  if (error) throw error;
}

export async function uploadPaymentProof(file, userId) {
  if (!supabase) return null;
  const path = `${userId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error } = await supabase.storage.from('payment-proofs').upload(path, file, { upsert: false });
  if (error) throw error;
  const { data, error: urlError } = await supabase.storage.from('payment-proofs').createSignedUrl(path, 300);
  if (urlError) throw urlError;
  return { path, signedUrl: data.signedUrl };
}

export async function signedPaymentProof(path) {
  if (!supabase || !path) return null;
  const { data, error } = await supabase.storage.from('payment-proofs').createSignedUrl(path, 300);
  if (error) throw error;
  return data.signedUrl;
}

export async function loadCompetitionResources(competitionId, participantId = null) {
  if (!supabase) return [];
  const base = () => supabase.from('competition_resources').select('*').eq('competition_id', competitionId).order('created_at', { ascending: false });
  const queries = participantId ? [base().is('participant_id',null), base().eq('participant_id',participantId)] : [base().is('participant_id',null)];
  const results = await Promise.all(queries);
  const failure = results.find(result => result.error);
  if (failure) throw failure.error;
  return results.flatMap(result => result.data || []);
}

const safePathPart = value => String(value || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
export async function uploadCompetitionResource({ file, competitionId, participantId, userId, category = 'Other Documents', description = '' }) {
  if (!supabase) throw new Error('Connect Supabase before uploading project files.');
  const parts = String(file.webkitRelativePath || file.name).split(/[\\/]/).map(safePathPart);
  const path = `${competitionId}/${participantId ? userId : `admin/${userId}`}/${crypto.randomUUID()}/${parts.join('/')}`;
  const { error: uploadError } = await supabase.storage.from('competition-files').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
  if (uploadError) throw uploadError;
  const payload = {
    competition_id: competitionId, participant_id: participantId || null,
    source: 'upload', resource_type: 'file', category, display_name: file.webkitRelativePath || file.name,
    description, storage_path: path, mime_type: file.type || 'application/octet-stream', file_size: file.size,
    uploaded_by: userId, visibility: participantId ? 'registered' : 'registered', enabled: true,
  };
  const { data, error } = await supabase.from('competition_resources').insert(payload).select().single();
  if (error) { await supabase.storage.from('competition-files').remove([path]); throw error; }
  return data;
}

export async function saveCompetitionResourceLink({ competitionId, participantId, userId, url, name, category = 'Other Documents', description = '' }) {
  if (!supabase) throw new Error('Connect Supabase before saving resource links.');
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a valid http or https URL.');
  const { data, error } = await supabase.from('competition_resources').insert({
    competition_id: competitionId, participant_id: participantId || null, source: 'link', resource_type: 'link',
    category, display_name: name || url, description, link_url: url, uploaded_by: userId,
    visibility: 'registered', enabled: true,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function saveGoogleDriveResources({ competitionId, participantId, userId, items }) {
  if (!supabase) throw new Error('Connect Supabase before saving Google Drive selections.');
  if (!items?.length) return [];
  const payload = items.map(item => ({
    competition_id: competitionId, participant_id: participantId || null, source: 'google_drive',
    resource_type: item.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
    category: 'Google Drive', display_name: item.name, google_file_id: item.id,
    link_url: item.url || `https://drive.google.com/open?id=${encodeURIComponent(item.id)}`,
    mime_type: item.mimeType || 'application/octet-stream', file_size: Number(item.size) || null,
    google_metadata: item, uploaded_by: userId, visibility: 'registered', enabled: true,
  }));
  const { data, error } = await supabase.from('competition_resources').insert(payload).select();
  if (error) throw error;
  return data || [];
}

export async function updateCompetitionResource(id, patch) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const allowed = { category: patch.category, description: patch.description, visibility: patch.visibility, enabled: patch.enabled, updated_at: new Date().toISOString() };
  const { data, error } = await supabase.from('competition_resources').update(allowed).eq('id', id).select().single();
  if (error) throw error;
  return data;
}

export async function removeCompetitionResource(resource) {
  if (!supabase) throw new Error('Supabase is not configured.');
  if (resource.storage_path) {
    const { error: storageError } = await supabase.storage.from('competition-files').remove([resource.storage_path]);
    if (storageError) throw storageError;
  }
  const { error } = await supabase.from('competition_resources').delete().eq('id', resource.id);
  if (error) throw error;
}

export async function resourceDownloadUrl(resource) {
  if (resource.source === 'link' || resource.source === 'google_drive') return resource.link_url;
  const { data, error } = await supabase.storage.from('competition-files').createSignedUrl(resource.storage_path, 300);
  if (error) throw error;
  return data.signedUrl;
}
