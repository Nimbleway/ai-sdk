export type SampleQuery = {
  id: string;
  title: string;
  score: number;
  prompt: string;
};

/**
 * Decision-led Agent API V2 examples adapted from the first-party platform
 * catalogue. Scores follow the shared 100-point query-quality rubric.
 */
export const SAMPLE_QUERIES: SampleQuery[] = [
  {
    id: 'P-WSA-research-regulatory',
    title: 'Regulatory launch decision',
    score: 96,
    prompt: `Decision: advise a product lead whether a generative-AI feature can launch in the
European Union this quarter without a high-risk compliance escalation.

Research material AI-regulation developments published in the EU during the last 45 days.
Classify each as enacted rule, binding enforcement action, official guidance, proposal, or
consultation. Source hierarchy: EU institutions and national regulators first; then court
records; use two independent reputable legal or news analyses only for interpretation.

Return JSON with jurisdiction, development_type, publication_date, effective_date,
affected_organizations, product_implication, primary_source_url, independent_source_urls,
confidence, and unresolved_questions. Cite every material claim. Preserve disagreements and
explain whether they arise from timing, jurisdiction, or interpretation; never infer legal
advice or an effective date that a source does not state.

Stop after 12 qualifying developments or 10 primary sources, whichever comes first. If fewer
than 5 qualify, report the shortfall and searched coverage rather than padding the result.`,
  },
  {
    id: 'P-WSA-enrichment-partnership',
    title: 'Partner shortlist enrichment',
    score: 95,
    prompt: `Decision: choose which three developer-platform partners should receive integration
engineering time next month. Enrich these public company records:
[{"company":"Browserbase","domain":"browserbase.com"},
 {"company":"Composio","domain":"composio.dev"},
 {"company":"Pipedream","domain":"pipedream.com"}]

For each row, verify current agent/tool integration surface, public contribution path, repository
activity in the last 90 days, documented web-data gap, and one evidence-backed distribution signal.
Source hierarchy: official product docs and organization repositories first; package registries and
official announcements second; independent reporting only as corroboration. Require at least two
independent domains per company.

Return the original keys plus integration_surface, contribution_path, latest_activity_date,
web_data_gap, distribution_signal, evidence_urls, confidence, contradictions, and recommended_rank.
Use null for unknown fields. Do not infer private roadmap, revenue, customer counts, or maintainer
interest. Preserve conflicting evidence and explain the source/date difference.

Stop after checking 5 authoritative sources per company or 12 minutes of research. Rank only rows
with official evidence for both integration surface and recent activity; otherwise mark ineligible.`,
  },
  {
    id: 'P-WSA-dataset-active-projects',
    title: 'Open-source integration pipeline',
    score: 94,
    prompt: `Decision: build a review queue of open-source projects where a web-data integration
could create meaningful user value, without spending engineering time on inactive or incompatible
projects.

Discover up to 12 distinct projects whose users need current external web data and whose documented
search integration is absent, stale, or limited. Eligibility: public repository, OSI-approved
license, a release or merged commit in the last 90 days, documented tool/plugin extension point,
and at least 1,000 GitHub stars. Source hierarchy: repository code, contribution guide, releases,
and official docs first; package registry second; independent community discussion only to identify
candidate pain, never to prove compatibility.

Return JSON rows with project, repository_url, license, stars_observed_at, latest_activity_date,
extension_point, verified_gap, user_job, integration_difficulty, evidence_urls, rejection_reason,
and confidence. Deduplicate forks, renamed projects, and projects in the same organization when they
share one integration surface. Preserve contradictions and reject candidates whose activity,
license, or extension point cannot be verified. Do not infer maintainer approval.

Stop at 12 accepted projects, 30 screened candidates, or 15 authoritative domains. Return accepted
and rejected rows plus remaining coverage gaps; never pad the target count.`,
  },
];
