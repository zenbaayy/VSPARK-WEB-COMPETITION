import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Trophy } from 'lucide-react';
import { loadPublicCompetitionWinners, supabase } from './lib/supabase';

const labels = ['FIRST', 'SECOND', 'THIRD'];
const medals = ['🥇', '🥈', '🥉'];

export default function ResultsPage({ db, go, selectedCompetitionId }) {
  const competitions = db.competitions || [];
  const [competitionId, setCompetitionId] = useState(selectedCompetitionId || competitions[0]?.id || '');
  const [winners, setWinners] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const competition = competitions.find((item) => item.id === competitionId);

  useEffect(() => {
    if (!selectedCompetitionId) return;
    setCompetitionId(selectedCompetitionId);
  }, [selectedCompetitionId]);

  useEffect(() => {
    if (!competitionId) { setWinners([]); return; }
    let active = true;
    const refresh = async () => {
      if (!supabase) {
        const localWinners = (competitions.find((item) => item.id === competitionId)?.winners || [])
          .filter((winner) => winner?.name)
          .map((winner, index) => ({ position: Number(winner.position || winner.placement || index + 1), ...winner }))
          .sort((a, b) => a.position - b.position);
        if (active) setWinners(localWinners);
        return;
      }
      try {
        if (active) { setLoading(true); setError(''); }
        const rows = await loadPublicCompetitionWinners(competitionId);
        if (active) setWinners(rows);
      } catch (err) {
        if (active) setError(err.message || 'Could not load announced winners.');
      } finally {
        if (active) setLoading(false);
      }
    };
    refresh();
    const timer = setInterval(refresh, 10000);
    return () => { active = false; clearInterval(timer); };
  }, [competitionId, db.competitions]);

  const ranked = useMemo(() => (db.results ?? db.participants)
    .filter((participant) => participant.evaluated)
    .map((participant) => ({ participant, score: Object.values(participant.evaluation || {}).reduce((sum, value) => sum + Number(value), 0) }))
    .sort((a, b) => b.score - a.score), [db.results, db.participants]);
  const resultsPublished = Boolean(db.config?.resultsPublished);

  return <main>
    <section className="page-hero"><div className="container page-hero-inner"><span className="kicker">THE BUILD SPEAKS</span><h1>Competition results</h1><p>Celebrating the teams who turned a challenge into a working product.</p><span className="page-hero-icon"><Trophy size={25}/></span></div></section>
    <div className="container results-page">
      {competitions.length > 1 && <label className="field results-competition-select"><span>Competition</span><select value={competitionId} onChange={(event) => setCompetitionId(event.target.value)}>{competitions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>}
      {competition && <div className="results-table-heading"><span className="kicker">{competition.title}</span><h2>Announced winners</h2></div>}
      {loading && !winners.length && <div className="results-empty"><p>Loading announced winners…</p></div>}
      {!!error && <div className="notice-bar" role="status">{error}. Apply the latest Supabase migration, then reload.</div>}
      {winners.length > 0
        ? <div className="podium">{winners.map((winner, index) => {
          const place = Math.max(1, Math.min(3, Number(winner.position || index + 1)));
          return <article className={`podium-card place-${place}`} key={`${competitionId}-${place}-${winner.name || index}`}><span className="podium-medal">{medals[place - 1]}</span><span className="kicker">{labels[place - 1]} PLACE</span><h2>{winner.name || winner.team || 'Winner'}</h2><p>{winner.project || 'Competition winner'}</p>{winner.batch && <span className="podium-batch">{winner.batch}</span>}</article>;
        })}</div>
        : !loading && <div className="results-empty"><span className="empty-trophy"><Trophy size={25}/></span><span className="kicker">NO WINNERS ANNOUNCED</span><h2>{competition ? 'The podium is still being prepared.' : 'Choose a competition to view its results.'}</h2><p>When the organizer announces winners, they will appear here automatically.</p></div>}
      {resultsPublished && ranked.length > 0 && <><div className="results-table-heading"><span className="kicker">JUDGE SCORING</span><h2>Final standings</h2></div><div className="panel"><div className="table-wrap"><table className="data-table"><thead><tr><th>Position</th><th>Participant / team</th><th>Project</th><th>Batch</th><th>Score</th></tr></thead><tbody>{ranked.map(({ participant, score }, index) => <tr key={participant.id}><td>#{index + 1}</td><td><b>{participant.team || participant.name}</b><small>{participant.name}</small></td><td>{participant.project}</td><td>{participant.batch}</td><td><b>{score} / 100</b></td></tr>)}</tbody></table></div></div></>}
      <button className="button button-outline" onClick={() => go()}>Back to competition <ArrowRight size={15}/></button>
    </div>
  </main>;
}
