// Team payloads for the tests. The two 200s are verbatim from a deployed backend; the third is the
// shape a backend with the repertoire views produces, built from the contract's schemas.

export const WINDOW_28 = {
  days: 28,
  team: { kind: "tenant", engineers: 2, name: "Eversynced" },
  sections: {
    repertoire: { enabled: false, reason: "not_implemented" },
    judgement_signals: {
      enabled: true,
      signals_by_engineer: {
        enabled: true,
        signals: [
          { key: "verification_coverage", unit: "share" },
          { key: "pushback_rate", unit: "share" },
          { key: "refinement_to_repair", unit: "ratio" },
          { key: "wholesale_accept", unit: "share" },
          { key: "model_fit", unit: "share" },
        ],
        engineers: [
          {
            developer: "gustavo",
            signals: [
              { key: "verification_coverage", value: 1 },
              { key: "refinement_to_repair", value: 3.142857142857143 },
            ],
          },
        ],
        median: [],
        engineers_named: 1,
        engineers_withheld: 0,
      },
      median_movement: { enabled: false, reason: "insufficient_data" },
      wholesale_watch: { enabled: false, reason: "insufficient_data" },
      dollar_savings: {
        enabled: true,
        basis: "API list-price equivalent, estimated upper bound",
        coverage: { complete: 0, incomplete: 3, no_telemetry: 10, unpriced: 0 },
      },
    },
  },
};

export const WINDOW_90 = {
  days: 90,
  team: { kind: "tenant", engineers: 2, name: "Eversynced" },
  sections: {
    repertoire: { enabled: false, reason: "not_implemented" },
    judgement_signals: {
      enabled: true,
      signals_by_engineer: {
        enabled: true,
        signals: [
          { key: "verification_coverage", unit: "share" },
          { key: "pushback_rate", unit: "share" },
          { key: "refinement_to_repair", unit: "ratio" },
          { key: "wholesale_accept", unit: "share" },
          { key: "model_fit", unit: "share" },
        ],
        engineers: [
          {
            developer: "gustavo",
            signals: [
              { key: "verification_coverage", value: 0.5 },
              { key: "pushback_rate", value: 0.14285714285714285 },
              { key: "refinement_to_repair", value: 2.1818181818181817 },
              { key: "wholesale_accept", value: 0 },
            ],
          },
        ],
        median: [],
        engineers_named: 1,
        engineers_withheld: 0,
      },
      median_movement: { enabled: false, reason: "insufficient_data" },
      wholesale_watch: {
        enabled: true,
        lines: { this_window: { unchallenged: 0, total: 18 } },
        sessions: { this_window: { unchallenged: 0, total: 2 } },
        verification_requested_never_ran: 3,
        by_repo: [{ codebase: "Eversynced/pheebs", unchallenged: 0, total: 18 }],
      },
      dollar_savings: {
        enabled: true,
        basis: "API list-price equivalent, estimated upper bound",
        coverage: { complete: 0, incomplete: 3, no_telemetry: 28, unpriced: 0 },
      },
    },
  },
};

const COMPETENCIES = ["Models", "Artifacts", "MCP", "Evals", "Context management", "Orchestration"];

function cells(states: string[]) {
  return states.map((state, i) => ({ name: COMPETENCIES[i], state, recurring_share: 0 }));
}

export const WITH_REPERTOIRE = {
  days: 28,
  team: { kind: "tenant", engineers: 5, name: "Eversynced" },
  sections: {
    repertoire: {
      enabled: true,
      adoption_funnel: {
        enabled: true,
        practices: [
          { name: "Models", unobserved: 2, adopted: 1, recurring: 1, insufficient_data: 1 },
          { name: "Artifacts", unobserved: 1, adopted: 1, recurring: 3, insufficient_data: 0 },
          { name: "MCP", unobserved: 3, adopted: 1, recurring: 1, insufficient_data: 0 },
          { name: "Evals", unobserved: 4, adopted: 1, recurring: 0, insufficient_data: 0 },
          {
            name: "Context management",
            unobserved: 2,
            adopted: 2,
            recurring: 1,
            insufficient_data: 0,
          },
          { name: "Orchestration", unobserved: 3, adopted: 1, recurring: 1, insufficient_data: 0 },
        ],
      },
      practice_heatmap: {
        enabled: true,
        competencies: COMPETENCIES,
        engineers: [
          {
            developer: "jim",
            competencies: cells([
              "unobserved",
              "recurring",
              "adopted",
              "unobserved",
              "recurring",
              "insufficient_data",
            ]),
          },
          {
            developer: "pam",
            competencies: cells([
              "recurring",
              "recurring",
              "n/a",
              "adopted",
              "adopted",
              "unobserved",
            ]),
          },
          // A row may leave a competency out, and that is a gap rather than a shifted cell.
          { developer: "dwight", competencies: cells(["recurring", "adopted"]) },
        ],
        engineers_named: 3,
        engineers_withheld: 2,
      },
      team_stats: {
        enabled: true,
        repos: 2,
        skill_reuse: [{ name: "/review", engineers: 2 }],
        subagent_reuse: [{ name: "code-reviewer", engineers: 2 }],
        connectors: [
          { name: "Slack", engineers: 2, reads: true, writes: true },
          { name: "Github", engineers: 1 },
        ],
        artifact_types: [
          { name: "MCP config", repos: 2 },
          { name: "Skills", repos: 2 },
        ],
        mcp_repos_in_use: 1,
      },
    },
    judgement_signals: {
      enabled: true,
      signals_by_engineer: {
        enabled: true,
        signals: [
          { key: "verification_coverage", unit: "share" },
          { key: "refinement_to_repair", unit: "ratio" },
        ],
        engineers: [
          {
            developer: "jim",
            signals: [
              { key: "verification_coverage", value: 0.62 },
              { key: "refinement_to_repair", value: 2.5 },
            ],
          },
          { developer: "pam", signals: [{ key: "verification_coverage", value: 0.9 }] },
          { developer: "dwight", signals: [] },
        ],
        median: [
          { key: "verification_coverage", value: 0.62 },
          { key: "refinement_to_repair", value: 2.5 },
        ],
        engineers_named: 3,
        engineers_withheld: 2,
      },
      median_movement: {
        enabled: true,
        signals: [
          {
            key: "verification_coverage",
            unit: "share",
            trend: [0.4, 0.45, 0.55, 0.62],
            annotations: [
              { index: 2, text: "Added a test skill to the shared repo" },
              { index: 9, text: "Pinned past the end of the trend" },
            ],
          },
          { key: "model_fit", unit: "share", trend: [0.7] },
        ],
      },
      wholesale_watch: {
        enabled: true,
        lines: {
          this_window: { unchallenged: 40, total: 400 },
          last_window: { unchallenged: 20, total: 150 },
        },
        sessions: {
          this_window: { unchallenged: 6, total: 30 },
          last_window: { unchallenged: 3, total: 12 },
        },
        verification_requested_never_ran: 4,
        by_repo: [
          { codebase: "Eversynced/pheebs", unchallenged: 10, total: 300 },
          { codebase: "Eversynced/web", unchallenged: 30, total: 100 },
        ],
      },
      dollar_savings: {
        enabled: true,
        basis: "API list-price equivalent, estimated upper bound",
        opportunity: 412.5,
        spend: 1830.25,
        coverage: { complete: 20, incomplete: 3, no_telemetry: 5, unpriced: 2 },
        distribution: {
          actual: [
            { class: "small", sessions: 2 },
            { class: "frontier", sessions: 18 },
          ],
          as_sized: [
            { class: "small", sessions: 11 },
            { class: "medium", sessions: 4 },
            { class: "frontier", sessions: 5 },
          ],
        },
      },
    },
  },
};

export const ALL_OFF = {
  days: 30,
  team: { kind: "tenant", engineers: 4 },
  sections: {
    repertoire: {
      enabled: true,
      adoption_funnel: { enabled: false, reason: "insufficient_data" },
      practice_heatmap: { enabled: false, reason: "insufficient_data" },
      team_stats: { enabled: false, reason: "insufficient_data" },
    },
    judgement_signals: {
      enabled: false,
      reason: "no_consent",
    },
  },
};
