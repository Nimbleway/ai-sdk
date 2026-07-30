'use client';

import { useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { SAMPLE_QUERIES } from '../lib/sample-queries';
import {
  actualResultFromToolOutput,
  classifyTrust,
  fullTrustFromToolOutput,
  inspectableEvidence,
  trustFromToolOutput,
} from '../lib/presentation';
import { csrfTokenFromCookie } from '../lib/browser-auth';
import { CHAT_REQUEST_ID_HEADER, newChatRequestId } from '../lib/request-id';
import {
  classifyCreateDiagnosticRead,
  CREATE_DIAGNOSTIC_READ_PATH,
  type CreateDiagnosticReadOutcome,
} from '../lib/create-diagnostics';

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
  const actualResult = actualResultFromToolOutput(output);
  const classification = output ? classifyTrust(output) : undefined;
  const fullTrust = fullTrustFromToolOutput(output);
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
      {classification && (
        <p className={`classification ${classification.label === 'GROUNDED' ? 'grounded' : ''}`}>
          Classification: <b>{classification.label}</b> · {classification.reason}
        </p>
      )}
      {actualResult !== undefined && (
        <details open className="actual-result">
          <summary>Actual result (uncropped)</summary>
          <pre>{actualResult}</pre>
        </details>
      )}
      {fullTrust !== undefined && (
        <details className="actual-result">
          <summary>Full trust metadata</summary>
          <pre>{fullTrust}</pre>
        </details>
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
  const requestId = useRef<string | undefined>(undefined);
  const spendAuthorized = useRef(false);
  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: '/api/chat',
        headers: (): Record<string, string> => {
          const headers: Record<string, string> = {};
          const csrf = csrfTokenFromCookie(document.cookie);
          if (csrf) headers['X-CSRF-Token'] = csrf;
          if (requestId.current) headers[CHAT_REQUEST_ID_HEADER] = requestId.current;
          return headers;
        },
      }),
    [],
  );
  const { messages, sendMessage, status } = useChat({ transport });
  const [input, setInput] = useState('');
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | undefined>();
  const [diagnosticRead, setDiagnosticRead] =
    useState<CreateDiagnosticReadOutcome | undefined>();
  const busy = authorizing || status === 'submitted' || status === 'streaming';

  async function readCreateDiagnostic(correlationId: string) {
    const csrf = csrfTokenFromCookie(document.cookie);
    if (!csrf) {
      setDiagnosticRead({ kind: 'unread', correlationId });
      return;
    }
    try {
      const response = await fetch(CREATE_DIAGNOSTIC_READ_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-csrf-token': csrf,
        },
        body: JSON.stringify({ requestId: correlationId }),
        cache: 'no-store',
        signal: AbortSignal.timeout(2_000),
      });
      const body =
        response.status === 200
          ? await response.json().catch(() => undefined)
          : undefined;
      setDiagnosticRead(
        classifyCreateDiagnosticRead({
          correlationId,
          httpStatus: response.status,
          body,
        }),
      );
    } catch {
      setDiagnosticRead({ kind: 'unread', correlationId });
    }
  }

  async function submit(text: string) {
    const task = text.trim();
    if (!task || busy) return;
    setAuthorizing(true);
    setAuthorizationError(undefined);
    setDiagnosticRead(undefined);
    let correlationId: string | undefined;
    try {
      if (!spendAuthorized.current) {
        const csrf = csrfTokenFromCookie(document.cookie);
        if (!csrf) throw new Error('The protected session is missing its CSRF token.');
        const response = await fetch('/__auth/spend/authorize', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
          },
          body: JSON.stringify({
            integration: 'vercel-ai-sdk-agent-v2',
            effortCeiling: 'low',
            createLimit: 1,
          }),
        });
        if (!response.ok) {
          const result = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(result.error ?? 'One-run authorization was rejected.');
        }
        spendAuthorized.current = true;
      }
      correlationId = newChatRequestId();
      requestId.current = correlationId;
      await sendMessage({ text: task });
      setInput('');
    } catch (error) {
      setAuthorizationError(
        error instanceof Error ? error.message : 'The protected run could not start.',
      );
    } finally {
      if (correlationId) {
        await readCreateDiagnostic(correlationId);
      }
      setAuthorizing(false);
    }
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
          <span>explicit 5m authorization · one create</span>
          <span>10s polling · zero create retries</span>
        </div>
      </header>

      <section className="messages" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>The language model chooses the real integration tools. Watch it start a generated
              Web Search Agent, retain both IDs, inspect status, and retrieve grounded output.</p>
            <div className="samples">
              {SAMPLE_QUERIES.map((sample) => (
                <button key={sample.id} onClick={() => { void submit(sample.prompt); }}>
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

      {authorizationError && <p className="authorization-error">{authorizationError}</p>}
      {diagnosticRead?.kind === 'receipt' && (
        <section className="tool" data-state={diagnosticRead.receipt.phase}>
          <div className="tool-head">
            <strong>Last durable create diagnostic</strong>
            <span>{diagnosticRead.receipt.phase.replaceAll('_', ' ')}</span>
          </div>
          <code>{diagnosticRead.correlationId}</code>
          <p>
            Last durably recorded phase:{' '}
            {diagnosticRead.receipt.phase.replaceAll('_', ' ')}
          </p>
          <p>
            Provider POST durably recorded:{' '}
            {diagnosticRead.receipt.providerPostAttempted ? 'yes' : 'no'} ·
            provider response durably recorded:{' '}
            {diagnosticRead.receipt.providerResponseReceived ? 'yes' : 'no'}
          </p>
          {diagnosticRead.receipt.httpStatus !== undefined && (
            <p>
              Durably recorded provider HTTP status:{' '}
              {diagnosticRead.receipt.httpStatus}
            </p>
          )}
          {diagnosticRead.receipt.localReason && (
            <p>
              Local classification:{' '}
              {diagnosticRead.receipt.localReason.replaceAll('_', ' ')}
            </p>
          )}
          <p>Automatic create retry: disabled</p>
        </section>
      )}
      {diagnosticRead?.kind === 'none' && (
        <section className="tool" data-state="no-receipt">
          <div className="tool-head">
            <strong>No durable failure receipt</strong>
            <span>authenticated read complete</span>
          </div>
          <code>{diagnosticRead.correlationId}</code>
          <p>
            A successful create clears its failure receipt. If this submission
            did not show durable run and agent IDs, a provider POST may have
            been sent; do not resubmit.
          </p>
          <p>Automatic create retry: disabled</p>
        </section>
      )}
      {diagnosticRead?.kind === 'unread' && (
        <section className="tool" data-state="unread">
          <div className="tool-head">
            <strong>Create diagnostic unread</strong>
            <span>verification incomplete</span>
          </div>
          <code>{diagnosticRead.correlationId}</code>
          <p>
            The durable receipt could not be read and verified. Provider create
            state is unknown; do not resubmit.
          </p>
          <p>Automatic create retry: disabled</p>
        </section>
      )}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void submit(input); }}>
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Give the model a research objective…"
          disabled={busy}
          rows={2}
        />
        <button disabled={busy || !input.trim()}>
          {authorizing ? 'Authorizing one run…' : busy ? 'Researching…' : 'Authorize & run once'}
        </button>
      </form>
    </main>
  );
}
