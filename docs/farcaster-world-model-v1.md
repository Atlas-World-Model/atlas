# Atlas x Farcaster World Model Spec v1

Status: draft.

Owner: Atlas Technology Labs.

Goal: build a logging, outcome-labeling, reputation, and predictive layer over
Farcaster Q&A interactions involving Atlas. The target corpus is structured
question -> answer -> outcome triples with contributor reputation signal and
rationale traces.

The first learning target is question selection: Atlas should become better at
identifying which questions are worth asking, which questions attract useful
contributors, and which questions produce actionable evidence for the world
model.

## Thesis

Most public conversational data is abundant and cheap. The scarce data is
structured, outcome-labeled, rationale-rich data where we can grade what was
worth asking, who helped answer it, what changed afterward, and why over time.

Atlas can create this publicly on Farcaster by asking questions, rewarding
answers through Looti, tracking outcomes, and updating contributor reputation
from behavioral and ground-truth labels.

Atlas is not primarily a prediction market. Prediction-style questions are useful
when they directly inform action and can be resolved cleanly. But Atlas's higher
value function is learning how to ask better questions: decision questions,
diagnostic questions, procedural questions, evaluation questions, and
question-generation questions.

## V1 Scope

In scope:

- Capture Atlas-initiated questions and responses on Farcaster.
- Log context, contributors, content, and rationale.
- Label outcomes across engagement, behavioral, and ground-truth tiers.
- Revisit questions on delayed 7, 30, and 90 day cadences.
- Compute contributor reputation from outcome-labeled history.
- Score question usefulness from participation, answer quality, actionability,
  and downstream world-model impact.
- Expose a minimal predictor for who should answer a new question and how much
  confidence Atlas should have in an answer.
- Track whether actionable campaigns led to interventions that were built,
  tested, evaluated, iterated, or retired.

Out of scope:

- Fine-tuning.
- Public reputation leaderboards.
- Corpus monetization or licensing.
- Cross-platform ingestion.

## Core Records

### Question

Fields:

- `question_id`
- `farcaster_cast_hash`
- `asked_at`
- `asker_fid`
- `text`
- `domain_tags`
- `question_type`: `prediction`, `recommendation`, `factual`, `opinion`,
  `procedural`
- `resolvability`: `verifiable_by_date`, `verifiable_on_action`,
  `subjective`, `unknown`
- `resolution_target_at`
- `context_snapshot_id`
- `intent`
- `success_test`: how Atlas expects to judge whether this was a good question
- `expected_action`: what Atlas might do differently if the answers are useful
  (`none`, `memory_update`, `follow_up_question`, `build_skill`, `build_tool`,
  `run_experiment`)

Important design note: `question_type` and `resolvability` determine which
outcome tiers apply and whether a question can become ground-truth labeled.
Not every valuable question is strictly provable; every valuable question should
still have a declared success test.

Question types should include:

- Prediction: can be checked by date or event.
- Decision: helps Atlas choose between actions.
- Diagnostic: explains why something happened or failed.
- Procedural: proposes a process Atlas can execute.
- Evaluation: judges whether an intervention improved a measurable outcome.
- Question-generation: helps Atlas decide what to ask next.

### Answer

Fields:

- `answer_id`
- `question_id`
- `farcaster_cast_hash`
- `responder_fid`
- `responded_at`
- `text`
- `rationale_extracted`
- `claims`
- `confidence_signaled`
- `cites_sources`
- `parent_answer_id`

### Outcome

Outcomes are mutable, delayed, and multi-tier.

Fields:

- `outcome_id`
- `question_id`
- `answer_id`
- `tier`: `engagement`, `behavioral`, `ground_truth`
- `resolved_at`
- `resolver`: `system`, `asker`, `atlas_agent`, `human_reviewer`
- `verdict`: `correct`, `incorrect`, `partially_correct`, `unverifiable`,
  `pending`
- `score`: normalized from -1 to 1
- `evidence`
- `confidence`
- `supersedes_outcome_id`

Outcome tiers:

- Engagement: likes, recasts, replies, thread depth. Feature, not label.
- Behavioral: did Atlas or an asker use, cite, re-engage, or reject the answer.
- Ground truth: verified by target date, Atlas action telemetry, or human
  review.

Question-level outcome labels should also track:

- Did the question attract relevant answers?
- Did it produce a candidate memory update?
- Did it change Atlas's behavior?
- Did it identify a better follow-up question?
- Was it too vague, too broad, or not worth asking again?
- Did Atlas build or test an intervention because of it?
- Did that intervention work by day 30 or day 90?

### Context Snapshot

Fields:

- `snapshot_id`
- `taken_at`
- `related_recent_casts`
- `active_contributors`
- `prior_interactions`
- `atlas_internal_state`

### Claim

Fields:

- `claim_id`
- `answer_id`
- `text`
- `claim_type`: `factual`, `predictive`, `causal`, `procedural`,
  `normative`
- `checkable`
- `check_method`
- `verdict`

### Contributor

Fields:

- `fid`
- `display_name`
- `first_seen_at`
- `domains_active_in`
- `total_answers`
- `reputation`

## Outcome Labeling Pipeline

Passive continuous jobs:

- Pull engagement metrics for open questions and answers.
- Update behavioral signals.
- Re-thread responses.

Scheduled checks:

- 7 day behavioral review.
- 30 day ground-truth check if applicable.
- 90 day final ground-truth check and reputation update.

Active resolution:

- Asker callback.
- Atlas action telemetry.
- Human review queue.

Counterfactual capture:

- Record which answer Atlas used.
- Record rejected answers and why.
- Record non-response from usually relevant contributors.

## Reputation

Reputation is per-contributor, per-domain, and time-decayed.

Shape:

```json
{
  "global": 0,
  "by_domain": {},
  "by_question_type": {},
  "sample_size": 0,
  "confidence": 0,
  "last_updated_at": null,
  "decay_half_life_days": 180
}
```

Rules:

- Engagement-only signals do not update reputation directly.
- Behavioral and ground-truth outcomes update reputation.
- Easy-question farming should be flagged as low information gain.
- Sybil resistance leans on Farcaster identity but should be treated as
  imperfect.

## Predictive Surface

V1 predictors:

- Contributor routing: given a question and context, rank likely helpful
  contributors.
- Answer quality: given a question-answer pair and contributor reputation,
  predict outcome score with confidence.
- Question usefulness: given a candidate question and context, predict whether
  it is likely to produce actionable evidence.

V1 implementation should be intentionally simple:

- Retrieval plus reputation-weighted scoring for contributor routing.
- Logistic regression or gradient-boosted trees for answer quality once there
  are enough resolved triples.
- Heuristic scoring for question usefulness at first: resolvability,
  actionability, specificity, novelty, domain fit, and expected contributor
  availability.

Evaluation:

- Hold out 20 percent of resolved triples.
- Track precision@k for routing.
- Track AUC and calibration for quality prediction.
- Track question usefulness against outcomes such as response quality, candidate
  memory creation, follow-up action, and later resolution.
- Compare against naive highest-reputation baselines.

## Storage

Primary store: Postgres.

Recommended extensions and services:

- pgvector for retrieval.
- Durable queue or pg_cron for delayed outcome checks.
- Neynar or direct Farcaster hub ingestion.
- Append-only audit log for every outcome update.

## Legal / Rights Posture

For v1:

- Treat corpus as internal use only.
- Do not distribute, license, or train external models on it.
- Capture explicit consent before formal contributor enrollment or external
  corpus use.
- Keep PII minimal: FID and public display name.

## Milestones

M1: logging live.

- Question, answer, and context snapshot records write for every Atlas
  Farcaster interaction.

M2: outcome pipeline.

- Engagement and behavioral labels run.
- Scheduled outcome queue works.
- Manual ground-truth review exists.

M3: reputation.

- Reputation scores computed from outcome labels.
- Internal dashboard shows scores.
- Atlas uses reputation to weight contributor selection.

M4: predictive surface.

- Question usefulness scorer, routing predictor, and answer quality predictor
  deployed.
- Weekly held-out eval runs.

M5: iteration.

- Tune taxonomy.
- Improve counterfactual capture.
- Decide whether and how reputation becomes contributor-visible.

## Implementation Implication

The beta markdown world loop remains useful, but it should be treated as an
artifact layer over a structured interaction-triple system.

Campaigns that identify unmet needs can become intervention loops. See
`docs/campaign-lifecycle-v1.md` for the Day 0, Day 7, Day 30, and Day 90
cadence.

The next infrastructure step is not richer markdown generation. It is a durable
Q/A/O store:

- `questions`
- `answers`
- `claims`
- `outcomes`
- `context_snapshots`
- `contributors`
- `audit_log`

Looti reward sets are still canonical public-input boundaries, but Atlas should
also log all relevant Farcaster responses so that future outcome and reputation
work has complete data.
