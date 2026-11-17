import { useEffect, useState } from 'react';
import { Plus, Save, Trash2, X, RefreshCw } from 'lucide-react';
import './CompetitionRulesManager.css';
import RichTextEditor from './RichTextEditor';
import { supabase, loadCompetitionRules, createCompetitionRule, updateCompetitionRule, deleteCompetitionRule } from './lib/supabase';
import { sanitizeRichText } from './lib/sanitizeRichText';

const emptyRule = () => ({ id: '', title: '', content: '', sort_order: 0 });

export default function CompetitionRulesManager({ competitions = [], selectedCompetitionId, backendReady, onToast }) {
  const [competitionId, setCompetitionId] = useState(selectedCompetitionId || competitions[0]?.id || '');
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!competitions.some(item => item.id === competitionId)) setCompetitionId(selectedCompetitionId || competitions[0]?.id || '');
  }, [competitions, competitionId, selectedCompetitionId]);

  useEffect(() => {
    if (!backendReady || !competitionId) { setRows([]); return; }
    let alive = true;
    let timer;
    const refresh = async () => {
      setLoading(true);
      try { const data = await loadCompetitionRules(competitionId); if (alive) setRows(data); }
      catch (error) { if (alive) onToast(`Could not load competition rules: ${error.message}`); }
      finally { if (alive) setLoading(false); }
    };
    refresh();
    const channel = supabase?.channel(`competition-rules-${competitionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'competition_rules', filter: `competition_id=eq.${competitionId}` }, () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 120);
      }).subscribe();
    return () => { alive = false; clearTimeout(timer); if (channel) supabase.removeChannel(channel); };
  }, [backendReady, competitionId, onToast]);

  async function save(event) {
    event.preventDefault();
    if (!editing?.title.trim()) { onToast('Enter a title for this rule.'); return; }
    setBusy(true);
    try {
      const payload = { ...editing, competitionId, content: sanitizeRichText(editing.content), sortOrder: Number(editing.sort_order) || 0 };
      const saved = editing.id ? await updateCompetitionRule({ ...payload, id: editing.id }) : await createCompetitionRule(payload);
      setRows(current => editing.id ? current.map(row => row.id === editing.id ? { ...row, ...saved } : row) : [...current, saved].sort((a,b) => a.sort_order - b.sort_order));
      setEditing(null);
      onToast(editing.id ? 'Competition rule updated.' : 'Competition rule added.');
    } catch (error) { onToast(`Rule was not saved: ${error.message}`); }
    finally { setBusy(false); }
  }

  async function remove(rule) {
    if (!window.confirm(`Delete “${rule.title}” from this competition?`)) return;
    setBusy(true);
    try { await deleteCompetitionRule(rule.id); setRows(current => current.filter(item => item.id !== rule.id)); onToast('Competition rule deleted.'); }
    catch (error) { onToast(`Rule was not deleted: ${error.message}`); }
    finally { setBusy(false); }
  }

  return <section className="panel admin-panel competition-rules-manager">
    <div className="panel-head"><div><span className="kicker">COMPETITION RULES</span><h3>Add, edit, or remove rules</h3></div>
      <div className="inline-actions"><button className="button button-outline button-sm" type="button" disabled={!backendReady || loading} onClick={() => loadCompetitionRules(competitionId).then(setRows).catch(error => onToast(`Could not refresh rules: ${error.message}`))}><RefreshCw size={14}/> Refresh</button><button className="button button-primary button-sm" type="button" disabled={!backendReady || !competitionId} onClick={() => setEditing(emptyRule())}><Plus size={15}/> Add rule</button></div>
    </div>
    {!backendReady ? <div className="notice-bar">Connect Supabase to manage saved competition rules.</div> : !competitions.length ? <div className="empty-table">Create a competition before adding its rules.</div> : <>
      <label className="field"><span>Competition</span><select value={competitionId} onChange={event => { setCompetitionId(event.target.value); setEditing(null); }}>
        {competitions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      {loading && <p className="muted">Refreshing rules…</p>}
      {!loading && !rows.length && <div className="empty-table">No individual rules saved for this competition yet. Existing competition description and legacy rules remain unchanged.</div>}
      {!!rows.length && <div className="competition-rule-list">{rows.map(rule => <article className="competition-rule-row" key={rule.id}>
        <div><span className="tag tag-neutral">#{rule.sort_order}</span><h4>{rule.title}</h4><div className="competition-rich-content" dangerouslySetInnerHTML={{ __html: sanitizeRichText(rule.content || '') }}/></div>
        <div className="inline-actions"><button type="button" className="button button-outline button-sm" disabled={busy} onClick={() => setEditing({ ...rule })}>Edit</button><button type="button" className="reject-action" disabled={busy} onClick={() => remove(rule)}>Delete <Trash2 size={14}/></button></div>
      </article>)}</div>}
    </>}
    {editing && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setEditing(null); }}>
      <form className="panel competition-editor rule-editor" onSubmit={save}>
        <div className="panel-head"><div><span className="kicker">{editing.id ? 'EDIT RULE' : 'NEW RULE'}</span><h3>{editing.title || 'Competition rule'}</h3></div><button type="button" className="icon-button" disabled={busy} onClick={() => setEditing(null)} aria-label="Close"><X/></button></div>
        <label className="field"><span>Rule title *</span><input maxLength="160" required value={editing.title} onChange={event => setEditing(current => ({ ...current, title: event.target.value }))}/></label>
        <label className="field"><span>Display order</span><input type="number" value={editing.sort_order ?? 0} onChange={event => setEditing(current => ({ ...current, sort_order: event.target.value }))}/></label>
        <RichTextEditor label="Rule details" value={editing.content || ''} placeholder="Write the rule or requirement" onChange={value => setEditing(current => ({ ...current, content: value }))}/>
        <div className="form-submit"><button className="button button-primary" disabled={busy} type="submit"><Save size={16}/>{busy ? 'Saving…' : 'Save rule'}</button><button className="button button-outline" disabled={busy} type="button" onClick={() => setEditing(null)}>Cancel</button></div>
      </form>
    </div>}
  </section>;
}
