export type TrustSummary = {
  confidence?: string;
  sources?: unknown[];
  claims?: unknown[];
};

export type InspectableSource = {
  url?: string;
  title?: string;
  excerpts?: string[];
};

export type InspectableEvidence = {
  sources: InspectableSource[];
  claims: Array<{
    key: string;
    confidence?: string;
    reasoning?: string;
    citations: InspectableSource[];
  }>;
  reasoning?: string;
};

const bounded = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

function source(value: unknown, withExcerpts = false): InspectableSource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const url = bounded(record.url ?? record.source_url, 500);
  const title = bounded(record.title ?? record.name, 160);
  const excerpts = withExcerpts && Array.isArray(record.excerpts)
    ? record.excerpts
        .map((excerpt) => bounded(excerpt, 360))
        .filter((excerpt): excerpt is string => Boolean(excerpt))
        .slice(0, 4)
    : undefined;
  return url || title || excerpts?.length ? { url, title, excerpts } : undefined;
}

export function trustFromToolOutput(
  toolOutput: Record<string, unknown> | undefined,
): TrustSummary | undefined {
  const resultOutput = toolOutput?.output as Record<string, unknown> | undefined;
  return (resultOutput?.trust ?? toolOutput?.trust) as TrustSummary | undefined;
}

export function inspectableEvidence(
  toolOutput: Record<string, unknown> | undefined,
): InspectableEvidence {
  const resultOutput = toolOutput?.output as Record<string, unknown> | undefined;
  const trust = trustFromToolOutput(toolOutput) as Record<string, unknown> | undefined;
  const sources = (Array.isArray(trust?.sources) ? trust.sources : [])
    .map((item) => source(item))
    .filter((item): item is InspectableSource => Boolean(item))
    .slice(0, 6);
  const claims = (Array.isArray(trust?.claims) ? trust.claims : [])
    .slice(0, 5)
    .map((value) => {
      const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
      const citations = (Array.isArray(record.citations) ? record.citations : [])
        .map((citation) => source(citation, true))
        .filter((item): item is InspectableSource => Boolean(item))
        .slice(0, 4);
      const callout = typeof record.callout === 'number' ? `Callout ${record.callout}` : undefined;
      const path = bounded(record.path, 240);
      return {
        key: callout ?? path ?? 'Unkeyed claim',
        confidence: bounded(record.confidence, 40),
        reasoning: bounded(record.reasoning, 600),
        citations,
      };
    });
  const reasoning = bounded(trust?.reasoning ?? resultOutput?.reasoning, 1_200);
  return { sources, claims, reasoning };
}
