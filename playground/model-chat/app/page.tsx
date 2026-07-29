'use client';

import { useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { SAMPLE_QUERIES } from '../lib/sample-queries';
import { inspectableEvidence, trustFromToolOutput } from '../lib/presentation';
import { csrfTokenFromCookie } from '../lib/browser-auth';
import { CHAT_REQUEST_ID_HEADER, newChatRequestId } from '../lib/request-id';

type ToolPart = {
  type: string;
  state: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errorText?: string;
};

function ToolCard({ part }: { part: ToolPart }) {
  const label = part.type.replace('tool-', '');
  const output = part.output;
  const ids = output
    ? [output.runId, output.agentId].filter((value) => typeof value === 'string').join(' · ')
    : '';
  const trust = trustFromToolOutput(output);
  const evidence = inspectableEvidence(output);
  return (
    <section className="tool" data-state={part.state}>
      <div className="tool-head">
        <span className="pulse" />
        <strong>{label}</strong>
        <span>{part.state}</span>
      </div>
      {ids && <code>{ids}</code>}
      {typeof output?.status === 'string' && <p>Status: {output.status}</p>}
      {trust && (
        <p className="trust">
          Trust: {trust.confidence ?? 'unrated'} · {trust.sources?.length ?? 0} sources ·{' '}
          {trust.claims?.length ?? 0} claims
        </p>
      )}
      {evidence.reasoning && (
        <details>
          <summary>Reasoning summary</summary>
          <p>{evidence.reasoning}</p>
        </details>
      )}
      {evidence.sources.length > 0 && (
        <details>
          <summary>Sources ({evidence.sources.length})</summary>
          <ul className="evidence-list">
            {evidence.sources.map((item, index) => (
              <li key={`${item.url ?? item.title}-${index}`}>
                {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title ?? item.url}</a> : <b>{item.title}</b>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {evidence.claims.length > 0 && (
        <details>
          <summary>Claims and citations ({evidence.claims.length})</summary>
          <ol className="evidence-list">
            {evidence.claims.map((claim, index) => (
              <li key={index}>
                <b>{claim.key}{claim.confidence ? ` · ${claim.confidence}` : ''}</b>
                {claim.reasoning && <span>{claim.reasoning}</span>}
                {claim.citations.map((citation, citationIndex) => (
                  <span key={citationIndex}>
                    {citation.url ? <a href={citation.url} target="_blank" rel="noreferrer">{citation.title ?? citation.url}</a> : citation.title}
                    {citation.excerpts?.map((excerpt, excerptIndex) => (
                      <q key={excerptIndex}>{excerpt}</q>
                    ))}
                  </span>
                ))}
              </li>
            ))}
          </ol>
        </details>
      )}
      {part.errorText && <p className="error">{part.errorText}</p>}
    </section>
  );
}

export default function Page() {
  const [nimbleKey, setNimbleKey] = useState('');
  const requestId = useRef<string | undefined>(undefined);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        headers: (): Record<string, string> => {
          const headers: Record<string, string> = {};
          if (nimbleKey.trim()) headers['X-Nimble-Api-Key'] = nimbleKey.trim();
          const csrf = csrfTokenFromCookie(document.cookie);
          if (csrf) headers['X-CSRF-Token'] = csrf;
          if (requestId.current) headers[CHAT_REQUEST_ID_HEADER] = requestId.current;
          return headers;
        },
      }),
    [nimbleKey],
  );
  const { messages, sendMessage, status } = useChat({ transport });
  const [input, setInput] = useState('');
  const busy = status === 'submitted' || status === 'streaming';

  function submit(text: string) {
    const task = text.trim();
    if (!task || busy) return;
    requestId.current = newChatRequestId();
    void sendMessage({ text: task });
    setInput('');
  }

  return (
    <main className="shell">
      <header>
        <div>
          <span className="eyebrow">LIVE INTEGRATION HARNESS / 02</span>
          <h1>Vercel AI SDK<br />meets Nimble Agent V2</h1>
        </div>
        <div className="policy">
          <b>Runtime policy</b>
          <span>generated agent · low effort</span>
          <span>10s polling · zero create retries</span>
        </div>
      </header>

      <section className="key-panel">
        <label htmlFor="nimble-key">Ephemeral Nimble API key</label>
        <input
          id="nimble-key"
          type="password"
          value={nimbleKey}
          onChange={(event) => setNimbleKey(event.target.value)}
          autoComplete="off"
          placeholder="Optional when the protected server fallback is configured"
        />
        <p>Held only in this page’s memory and sent to the protected server per request.</p>
      </section>

      <section className="messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>The language model chooses the real integration tools. Watch it start a generated
              Web Search Agent, retain both IDs, inspect status, and retrieve grounded output.</p>
            <div className="samples">
              {SAMPLE_QUERIES.map((sample) => (
                <button key={sample.id} onClick={() => submit(sample.prompt)}>
                  <b>{sample.title}</b>
                  <span>{sample.score}/100 query contract</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <article className={`message ${message.role}`} key={message.id}>
            <span className="role">{message.role}</span>
            {message.parts.map((part, index) => {
              if (part.type === 'text') return <p key={index} className="bubble">{part.text}</p>;
              if (part.type.startsWith('tool-')) {
                return <ToolCard key={index} part={part as unknown as ToolPart} />;
              }
              return null;
            })}
          </article>
        ))}
      </section>

      <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(input); }}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Give the model a research objective…"
          disabled={busy}
          rows={2}
        />
        <button disabled={busy || !input.trim()}>{busy ? 'Researching…' : 'Run agent'}</button>
      </form>
    </main>
  );
}
