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
    type: row.participation_type, team: row.team || '', ...(row.member || {}),
    payment: row.payment_status, paymentRef: row.payment_ref, paymentProof: row.payment_proof_path,
    paymentComment: row.payment_comment, project: row.project || '', github: row.github_url || '',
    live: row.live_url || '', drive: row.drive_url || '', submittedAt: row.submitted_at,
    competitionId: row.competition_id, description: row.project_description || '',
    technologies: row.technologies || '', apis: row.api_details || '',
    startedAt: row.started_at, evaluation: row.evaluation || {}, feedback: row.feedback || '',
    evaluated: row.evaluated,
  };
}

function fromRegistration(row, legacyRow = null) {
  const submission = Array.isArray(row.competition_submissions)
    ? row.competition_submissions[0]
    : row.competition_submissions;
  const competition = Array.isArray(row.competitions) ? row.competitions[0] : row.competitions;
  const apis = Array.isArray(submission?.external_apis)
    ? submission.external_apis.map(api => `${api.name || ''} | ${api.url || ''}`).join('\n')
    : '';
  return {
    id: row.id, registrationId: row.id, legacyParticipantId: legacyRow?.id || null,
    userId: row.user_id, name: row.participant_name || row.registration_number,
    email: row.email || '', university: row.university_name, winnerStatus: row.winner_status || 'Not Announced',
    registrationDate: row.created_at, reg: row.registration_number, phone: row.phone, department: row.department,
    semester: row.semester, batch: row.batch, type: row.participation_type, team: row.team_name || '',
    ...(row.member_details || {}), payment: row.payment_status, paymentRef: row.payment_ref,
    paymentProof: row.payment_proof_path, paymentComment: row.payment_comment,
    project: submission?.project_title || '', github: submission?.github_url || '',
    live: submission?.live_url || '', drive: submission?.participant_drive_url || '',
    submittedAt: submission?.submitted_at || null, startedAt: submission?.started_at || null,
    competitionId: row.competition_id, description: submission?.project_description || '',
    technologies: submission?.technologies || '', apis, readme: !!submission?.readme_confirmed,
    evaluation: submission?.scores || {}, feedback: submission?.judge_feedback || '',
    evaluated: !!submission?.evaluated, competition,
  };
}

function toApiArray(value = '') {
  return String(value).split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const separator = line.indexOf('|');
    return separator < 0
      ? { name: line, url: '' }
      : { name: line.slice(0, separator).trim(), url: line.slice(separator + 1).trim() };
  });
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
    ? await supabase.from('profiles').select('id,full_name,role').eq('id', user.id).limit(1)
    : { data: [], error: null };
  if (profileResult.error) throw profileResult.error;
  const profileRow = profileResult.data?.[0] || null;
  const role = profileRow?.role || 'participant';
  // Participant sessions may not have SELECT access to the private settings table.
  // The public view is intended for the website and also contains the public config.
  const settingsSource = role === 'admin' ? 'competition_settings' : 'public_competition_settings';
  // Read as an array to avoid PostgREST single-object coercion blocking login.
  const settingsResult = await supabase.from(settingsSource).select('*').eq('id', 1).limit(1);
  if (settingsResult.error) throw settingsResult.error;
  const settingsRow = settingsResult.data?.[0];
  if (!settingsRow) {
    throw new Error(`No id=1 settings row is visible in ${settingsSource} for this account. Check Supabase SELECT policies/view.`);
  }
  const registrationQuery = supabase.from('competition_registrations')
    .select('*,competition_submissions(*),competitions(*)')
    .order('created_at', { ascending: false });
  const rosterResult = user && role === 'admin'
    ? await registrationQuery
    : user
      ? await registrationQuery.eq('user_id', user.id)
      : { data: [], error: null };
  const resultsResult = await supabase.rpc('published_results_by_competition');
  const legacyRosterResult = user
    ? role === 'admin'
      ? await supabase.from('participants').select('id,user_id,competition_id')
      : await supabase.from('participants').select('id,user_id,competition_id').eq('user_id', user.id)
    : { data: [], error: null };
  const competitionsResult = role === 'admin'
    ? await supabase.from('competitions').select('*').order('created_at', { ascending: false })
    : await supabase.from('public_competition_catalog').select('*').order('starts_at', { ascending: true });
  if (rosterResult.error) throw rosterResult.error;
  if (legacyRosterResult.error) throw legacyRosterResult.error;
  if (resultsResult.error) throw resultsResult.error;
  if (competitionsResult.error) throw competitionsResult.error;
  const s = settingsRow;
  return {
    role,
    account: user ? { id: user.id, email: user.email, name: profileRow?.full_name || user.user_metadata?.full_name || user.email, role } : null,
    participants: (rosterResult.data || []).map(row => fromRegistration(row,
      (legacyRosterResult.data || []).find(legacy => legacy.user_id === row.user_id && legacy.competition_id === row.competition_id))),
    results: (resultsResult.data || []).map(row => ({
      id: row.id, name: row.name, team: row.team, batch: row.batch, project: row.project,
      evaluation: row.evaluation || {}, evaluated: !!row.evaluated, submittedAt: row.submitted_at,
      competitionId: row.competition_id,
    })),
    competitions: (competitionsResult.data || []).map(fromCompetition),
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
    id: row.id, title: row.title, shortDescription: row.short_description,
    description: row.detailed_description, university: row.university_name, department: row.department,
    rules: row.rules_html, task: row.task_html || row.task, startsAt: row.starts_at,
    submissionInstructions: row.submission_instructions || '', requiredTechnologies: row.required_technologies || '',
    endsAt: row.ends_at, registrationDeadline: row.registration_deadline, status: row.status,
    driveUploadUrl: row.drive_upload_url || '', driveEnabled: row.drive_enabled,
    durationMinutes: row.duration_minutes || 120, mode: row.mode || 'Online', registrationOpen: row.registration_open !== false,
    paymentEnabled: !!row.payment_enabled, paymentAmount: row.payment_amount || '',
    paymentInstructions: row.payment_instructions || '',
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

function toCompetition(item, userId) {
  return {
    title: item.title, short_description: item.shortDescription || '',
    detailed_description: item.description || '', university_name: item.university || '',
    department: item.department || '', rules_html: item.rules || '', task_html: item.task || '',
    task: item.task || '', submission_instructions: item.submissionInstructions || '', required_technologies: item.requiredTechnologies || '',
    starts_at: item.startsAt || null, ends_at: item.endsAt || null,
    registration_deadline: item.registrationDeadline || null, status: item.status || 'upcoming',
    drive_upload_url: item.driveUploadUrl || null, drive_enabled: !!item.driveEnabled,
    duration_minutes: item.durationMinutes || 120, mode: item.mode || 'Online', registration_open: item.registrationOpen !== false,
    payment_enabled: !!item.paymentEnabled, payment_amount: item.paymentAmount || null,
    payment_instructions: item.paymentInstructions || null,
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
  let { data, error } = await supabase.auth.signUp({
    email: values.email,
    password,
    options: { data: { ...profile, full_name: values.name, competition_id: values.competitionId } },
  });
  let user = data?.user || null;
  const existingAccount = error && /already registered|user exists|email.*exists/i.test(error.message)
    || (!error && user && Array.isArray(user.identities) && user.identities.length === 0);
  if (existingAccount) {
    const signedIn = await supabase.auth.signInWithPassword({ email: values.email, password });
    if (signedIn.error) throw new Error(`This email already has an account. Sign in with that account (and confirm its email first) to register for another competition. ${signedIn.error.message}`);
    data = signedIn.data;
    user = data.user;
  } else if (error) {
    throw error;
  } else if (!data?.session) {
    return { confirmationRequired: true };
  }
  if (!user || !values.competitionId) throw new Error('Select a competition before registering.');
  const { data: existingRegistration, error: lookupError } = await supabase.from('competition_registrations')
    .select('id').eq('user_id', user.id).eq('competition_id', values.competitionId).maybeSingle();
  if (lookupError) throw lookupError;
  if (!existingRegistration) {
    const { error: registrationError } = await supabase.from('competition_registrations').insert({
      competition_id: values.competitionId, user_id: user.id, registration_number: values.reg,
      participant_name: values.name, email: values.email, phone: values.phone,
      university_name: values.university, department: values.department, semester: values.semester,
      batch: values.batch, participation_type: values.type, team_name: values.team || null,
      member_details: values.type === 'Team' ? {
        memberName: values.memberName, memberReg: values.memberReg,
        memberEmail: values.memberEmail, memberPhone: values.memberPhone,
      } : {},
    });
    if (registrationError) throw registrationError;
  }
  return { user };
}

export async function saveParticipant(id, participant, isAdmin, patch = {}) {
  if (!supabase || !participant) return;
  if (!isAdmin && patch.startedAt) {
    const { data, error } = await supabase.rpc('start_registration_timer', { p_registration_id: id });
    if (error) throw error;
    return { started_at: data };
  }
  if (!isAdmin && patch.saveDraft) {
    const { data, error } = await supabase.rpc('save_registration_submission_draft', {
      p_registration_id:id, p_project:participant.project || '', p_description:participant.description || '',
      p_technologies:participant.technologies || '', p_api_details:toApiArray(participant.apis),
      p_github:participant.github || '', p_live:participant.live || '', p_drive:participant.drive || '',
      p_readme_confirmed:!!participant.readme,
    });
    if (error) throw error;
    return data;
  }
  if (!isAdmin && patch.submittedAt) {
    const { data, error } = await supabase.rpc('submit_registration_project', {
      p_registration_id:id, p_project:participant.project, p_description:participant.description || '',
      p_technologies:participant.technologies || '', p_api_details:toApiArray(participant.apis),
      p_github:participant.github, p_live:participant.live, p_drive:participant.drive,
      p_readme_confirmed:!!participant.readme,
    });
    if (error) throw error;
    return data;
  }
  if (isAdmin) {
    const { error } = await supabase.rpc('admin_update_competition_registration', {
      p_registration_id: id,
      p_patch: {
        payment_ref: participant.paymentRef || null,
        payment_proof_path: participant.paymentProof || null,
        payment_status: participant.payment, payment_comment: participant.paymentComment || null,
        winner_status: participant.winnerStatus || 'Not Announced', scores: participant.evaluation || {},
        judge_feedback: participant.feedback || '', evaluated: !!participant.evaluated,
      },
    });
    if (error) throw error;
  } else {
    const { error } = await supabase.rpc('save_registration_payment', {
      p_registration_id: id, p_phone: participant.phone || '',
      p_payment_ref: participant.paymentRef || null, p_payment_proof_path: participant.paymentProof || null,
    });
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

export async function loadCompetitionResources(competitionId, registrationId = null, legacyParticipantId = null) {
  if (!supabase) return [];
  const base = () => supabase.from('competition_resources').select('*').eq('competition_id', competitionId).order('created_at', { ascending: false });
  const queries = [base().is('registration_id',null).is('participant_id',null)];
  if (registrationId) queries.push(base().eq('registration_id', registrationId));
  if (legacyParticipantId) queries.push(base().eq('participant_id', legacyParticipantId));
  const results = await Promise.all(queries);
  const failure = results.find(result => result.error);
  if (failure) throw failure.error;
  return results.flatMap(result => result.data || []);
}

const safePathPart = value => String(value || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'file';
export async function uploadCompetitionResource({ file, competitionId, registrationId, participantId, userId, category = 'Other Documents', description = '' }) {
  if (!supabase) throw new Error('Connect Supabase before uploading project files.');
  const parts = String(file.webkitRelativePath || file.name).split(/[\\/]/).map(safePathPart);
  const isParticipantResource = !!(registrationId || participantId);
  const path = `${competitionId}/${isParticipantResource ? userId : `admin/${userId}`}/${crypto.randomUUID()}/${parts.join('/')}`;
  const { error: uploadError } = await supabase.storage.from('competition-files').upload(path, file, { upsert: false, contentType: file.type || 'application/octet-stream' });
  if (uploadError) throw uploadError;
  const payload = {
    competition_id: competitionId, participant_id: participantId || null, registration_id: registrationId || null,
    source: 'upload', resource_type: 'file', category, display_name: file.webkitRelativePath || file.name,
    description, storage_path: path, mime_type: file.type || 'application/octet-stream', file_size: file.size,
    uploaded_by: userId, visibility: participantId ? 'registered' : 'registered', enabled: true,
  };
  const { data, error } = await supabase.from('competition_resources').insert(payload).select().single();
  if (error) { await supabase.storage.from('competition-files').remove([path]); throw error; }
  return data;
}

export async function saveCompetitionResourceLink({ competitionId, registrationId, participantId, userId, url, name, category = 'Other Documents', description = '' }) {
  if (!supabase) throw new Error('Connect Supabase before saving resource links.');
  if (!/^https?:\/\//i.test(url)) throw new Error('Enter a valid http or https URL.');
  const { data, error } = await supabase.from('competition_resources').insert({
    competition_id: competitionId, participant_id: participantId || null, registration_id: registrationId || null, source: 'link', resource_type: 'link',
    category, display_name: name || url, description, link_url: url, uploaded_by: userId,
    visibility: 'registered', enabled: true,
  }).select().single();
  if (error) throw error;
  return data;
}

export async function saveGoogleDriveResources({ competitionId, registrationId, participantId, userId, items }) {
  if (!supabase) throw new Error('Connect Supabase before saving Google Drive selections.');
  if (!items?.length) return [];
  const payload = items.map(item => ({
    competition_id: competitionId, participant_id: participantId || null, registration_id: registrationId || null, source: 'google_drive',
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
