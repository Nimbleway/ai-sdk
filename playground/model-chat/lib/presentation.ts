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

export type TrustClassification = {
  label: 'GROUNDED' | 'DEGRADED / HOLD' | 'PENDING';
  reason: string;
};

const bounded = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;

function inspectableUrl(value: unknown): string | undefined {
  const candidate = bounded(value, 500);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function source(value: unknown, withExcerpts = false): InspectableSource | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const url = inspectableUrl(record.url ?? record.source_url);
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

/**
 * Return the complete answer from the Agent V2 result envelope. This value is
 * intentionally not truncated: the hosted harness must make the retrieved
 * result inspectable rather than presenting a preview as if it were evidence.
 */
export function actualResultFromToolOutput(
  toolOutput: Record<string, unknown> | undefined,
): string | undefined {
  if (toolOutput?.ready !== true || toolOutput.status !== 'completed') return undefined;
  const resultOutput = toolOutput?.output;
  if (!resultOutput || typeof resultOutput !== 'object') return undefined;
  const record = resultOutput as Record<string, unknown>;
  if (typeof record.text === 'string') return record.text;
  if (record.json && typeof record.json === 'object') {
    return JSON.stringify(record.json, null, 2);
  }
  return undefined;
}

export function classifyTrust(
  toolOutput: Record<string, unknown> | undefined,
): TrustClassification {
  if (toolOutput?.ready !== true) {
    return {
      label: 'PENDING',
      reason: 'The lifecycle has not returned a completed result.',
    };
  }

  const trust = trustFromToolOutput(toolOutput);
  if (!trust) {
    return {
      label: 'DEGRADED / HOLD',
      reason: 'The completed result has no trust metadata.',
    };
  }

  const sourceCount = Array.isArray(trust.sources)
    ? trust.sources.filter((item) => Boolean(source(item)?.url)).length
    : 0;
  const citationCount = Array.isArray(trust.claims)
    ? trust.claims.reduce<number>((total, claim) => {
        if (!claim || typeof claim !== 'object') return total;
        const citations = (claim as Record<string, unknown>).citations;
        return total + (
          Array.isArray(citations)
            ? citations.filter((item) => Boolean(source(item, true)?.url)).length
            : 0
        );
      }, 0)
    : 0;
  const confidence = typeof trust.confidence === 'string'
    ? trust.confidence.trim().toLowerCase()
    : '';

  if (sourceCount === 0 || citationCount === 0) {
    return {
      label: 'DEGRADED / HOLD',
      reason: `Grounding is incomplete (${sourceCount} sources, ${citationCount} citations).`,
    };
  }
  if (confidence !== 'high' && confidence !== 'medium') {
    return {
      label: 'DEGRADED / HOLD',
      reason: `Trust confidence is ${confidence || 'unrated'}.`,
    };
  }
  return {
    label: 'GROUNDED',
    reason: `${sourceCount} sources and ${citationCount} claim citations are available for inspection.`,
  };
}

export function fullTrustFromToolOutput(
  toolOutput: Record<string, unknown> | undefined,
): string | undefined {
  const trust = trustFromToolOutput(toolOutput);
  return trust ? JSON.stringify(trust, null, 2) : undefined;
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
