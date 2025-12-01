import { useMemo } from 'react';
import IntakePage from './IntakePage';
import PlanPage from './PlanPage';

function useRouteHash() {
  const hash = typeof window !== 'undefined' ? window.location.hash : '#/intake';
  const current = hash || '#/intake';
  function nav(to: '#/intake' | '#/plan') { window.location.hash = to; }
  return { current, nav };
}

export default function App() {
  const { current, nav } = useRouteHash();
  const Page = useMemo(() => (current.startsWith('#/plan') ? PlanPage : IntakePage), [current]);

  return (
    <>
      <header>
        <div className="container">{/* align header with body */}
          <strong>velOzity Ops</strong>
          <a href="#/intake" onClick={(e) => { e.preventDefault(); nav('#/intake'); }}
             className={current.startsWith('#/intake') ? 'active' : ''}>Intake</a>
          <a href="#/plan" onClick={(e) => { e.preventDefault(); nav('#/plan'); }}
             className={current.startsWith('#/plan') ? 'active' : ''}>Plan</a>
          <span className="right muted badge">
            ENV: {(import.meta as any).env?.VITE_API_BASE ? 'Remote' : 'Local'}
          </span>
        </div>
      </header>

      <div className="container"><Page /></div>
    </>
  );
}
