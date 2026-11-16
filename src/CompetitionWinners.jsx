import { useEffect, useState } from 'react';
import { Award, Save, Trash2 } from 'lucide-react';
import { loadCompetitionDetails } from './lib/supabase';

export default function CompetitionWinners({ competitions = [], participants = [], onSave, onDelete, backendReady, onToast }) {
  const [competitionId, setCompetitionId] = useState(competitions[0]?.id || '');
  const [participantId, setParticipantId] = useState('');
  const [placement, setPlacement] = useState('1');
  const [winners, setWinners] = useState([]);
  const [busy, setBusy] = useState(false);
  const competition = competitions.find(item => item.id === competitionId);
  const eligible = participants.filter(item => item.competitionId === competitionId);

  useEffect(() => {
    if (!competitionId) { setWinners([]); return; }
    let alive = true;
    if (!backendReady) { setWinners(competition?.winners || []); return () => { alive = false; }; }
    loadCompetitionDetails(competitionId).then(result => { if (alive) setWinners(result?.winners || []); })
      .catch(error => { if (alive) onToast(`Could not load competition winners: ${error.message}`); });
    return () => { alive = false; };
  }, [competitionId, backendReady, competition?.winners]);

  async function save() {
    if (!participantId) return onToast('Select a registered participant first.');
    setBusy(true);
    try {
      await onSave({ competitionId, participantId, placement: Number(placement) });
      const result = backendReady ? await loadCompetitionDetails(competitionId) : null;
      setWinners(result?.winners || [
        ...winners.filter(item => Number(item.position) !== Number(placement)),
        { position: Number(placement), name: eligible.find(item => item.id === participantId)?.team || eligible.find(item => item.id === participantId)?.name, project: eligible.find(item => item.id === participantId)?.project || '' },
      ]);
    } catch (error) { onToast(`Winner could not be saved: ${error.message}`); }
    finally { setBusy(false); }
  }

  async function remove(position) {
    setBusy(true);
    try { await onDelete({ competitionId, placement: Number(position) }); setWinners(items => items.filter(item => Number(item.position) !== Number(position))); }
    catch (error) { onToast(`Winner announcement could not be removed: ${error.message}`); }
    finally { setBusy(false); }
  }

  return <section className="panel admin-panel competition-winners-panel">
    <div className="panel-head"><div><span className="kicker">COMPETITION RESULTS</span><h3>Manage winners</h3></div><Award size={20}/></div>
    <p>Choose winners separately for each competition. Announcements appear on that competition’s details page.</p>
    <div className="settings-row">
      <label className="field"><span>Competition</span><select value={competitionId} onChange={event => setCompetitionId(event.target.value)}>{competitions.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
      <label className="field"><span>Participant / team</span><select value={participantId} onChange={event => setParticipantId(event.target.value)}><option value="">Select a registered participant</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.team || item.name} · {item.project || 'No project yet'}</option>)}</select></label>
      <label className="field"><span>Position</span><select value={placement} onChange={event => setPlacement(event.target.value)}><option value="1">1st place</option><option value="2">2nd place</option><option value="3">3rd place</option></select></label>
    </div>
    <button className="button button-primary" disabled={busy || !competitionId} onClick={save}><Save size={16}/>{busy ? 'Saving…' : 'Save / announce winner'}</button>
    <div className="winner-admin-list">{winners.length ? winners.slice().sort((a,b)=>a.position-b.position).map(item => <div key={item.position} className="winner-admin-row"><span><b>{['1st','2nd','3rd'][Number(item.position)-1]} place</b> · {item.name}{item.project ? ` · ${item.project}` : ''}</span><button className="reject-action" disabled={busy} onClick={() => remove(item.position)}>Remove <Trash2 size={14}/></button></div>) : <p className="muted">No winners announced for this competition yet.</p>}</div>
  </section>;
}
