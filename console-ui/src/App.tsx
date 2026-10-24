import { useEffect, useRef, useState } from "react";
import { DeadLetters } from "./views/DeadLetters";
import { Lookup } from "./views/Lookup";
import { Overview } from "./views/Overview";

const VIEWS = [
  { hash: "#/", title: "Overview" },
  { hash: "#/dead-letters", title: "Dead letters" },
  { hash: "#/lookup", title: "Car and location lookup" },
] as const;

type ViewHash = (typeof VIEWS)[number]["hash"];

function viewFromHash(): ViewHash {
  const match = VIEWS.find((v) => v.hash === window.location.hash);
  return match ? match.hash : "#/";
}

export function App() {
  const [view, setView] = useState<ViewHash>(viewFromHash);
  // Held in this tab's memory only, and sent only with actions.
  const [token, setToken] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const onChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  // After switching views, keyboard and screen-reader users land on the new
  // view's title instead of staying on the link they used.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [view]);

  const title = VIEWS.find((v) => v.hash === view)?.title ?? "Overview";

  return (
    <>
      <a className="skip-link" href="#view-title">
        Skip to content
      </a>
      <header className="top">
        <div className="top-row">
          <h1>Railcar console</h1>
          <div className="token">
            <label htmlFor="operator-token">Operator token</label>
            <input
              id="operator-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(e) => setToken(e.target.value.trim())}
              aria-describedby="token-help"
            />
            <p id="token-help" className="hint">
              Needed to replay, discard or silence. Kept in this tab only.
            </p>
          </div>
        </div>
        <nav aria-label="Views">
          <ul>
            {VIEWS.map((v) => (
              <li key={v.hash}>
                <a href={v.hash} aria-current={v.hash === view ? "page" : undefined}>
                  {v.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main>
        <h2 id="view-title" tabIndex={-1} ref={heading}>
          {title}
        </h2>
        {view === "#/" && <Overview token={token} />}
        {view === "#/dead-letters" && <DeadLetters token={token} />}
        {view === "#/lookup" && <Lookup />}
      </main>
      <footer>
        <p className="hint">All data in this stack is synthetic. The page refreshes every 5 seconds.</p>
      </footer>
    </>
  );
}
