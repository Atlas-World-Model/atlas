# Atlas Campaign Lifecycle v1

Status: draft.

Purpose: define how Atlas moves from public question to rewarded evidence,
candidate memory, possible intervention, outcome labels, and durable world-model
updates.

## Core Loop

Atlas's autonomy loop is:

```text
Ask -> Reward -> Synthesize -> Build/Test -> Evaluate -> Iterate -> Remember
```

Not every campaign enters every stage. The deciding field is
`expected_action`.

## Expected Actions

Each Atlas question must declare one expected action:

- `none`: collect evidence only.
- `memory_update`: draft a candidate world-memory update.
- `follow_up_question`: use the result to ask a sharper question.
- `build_skill`: create or revise an executable Atlas skill.
- `build_tool`: create a small tool, dashboard, analysis, or product surface.
- `run_experiment`: change Atlas behavior or process and evaluate the result.

Only `build_skill`, `build_tool`, and `run_experiment` enter the day 8-29
intervention window by default.

## Timeline

### Day 0: Ask

Atlas publishes a campaign prompt.

Required fields:

- Problem: what Atlas is trying to understand or solve.
- Current belief: what Atlas currently thinks.
- Question: what humans should answer.
- Resolvability: how the question can later be judged.
- Success test: how Atlas will know whether this was worth asking.
- Expected action: what Atlas may do if the answers are useful.
- Reward: campaign budget and ranking rule.

The prompt should be simple. Deeper context can be posted as a thread or linked
from `joinatlas.xyz`.

### Day 1-7: Collect

Looti ranks responses. Atlas logs:

- Question record.
- Answer records.
- Claim records.
- Contributor records.
- Engagement features.
- Context snapshot.

Atlas may post status updates, but it should not mutate durable world memory
during collection.

### Day 7: Synthesize

Atlas ingests the frozen reward set and writes:

- `reward-set.json`
- `evidence.md`
- `memory-candidate.md`
- `review.md`
- `atlas-allocations.json`

Atlas then chooses one result:

- no action
- candidate memory only
- follow-up question
- build/test intervention
- manual review required

This is the first meaningful outcome label for question usefulness.

### Day 8-29: Build/Test

This window only applies when `expected_action` warrants intervention.

Atlas builds the smallest useful version of the proposed intervention:

- skill
- dashboard
- analysis
- internal tool
- public explainer
- workflow change
- campaign process change
- Farcaster behavior change

The intervention must have:

- an owner: Atlas agent, human operator, or both.
- a scope limit.
- an evaluation plan.
- a rollback or retirement condition.
- linked evidence from the campaign reward set.

Atlas should publish a plain-language update:

```text
I learned X from the campaign.
I am testing Y for the next two weeks.
Success test: Z.
```

### Day 30: Evaluate

Atlas checks early outcomes.

For tools/skills:

- Was it built?
- Was it used?
- Did it solve the stated problem?
- Did users give feedback?
- Did it change Atlas behavior?
- Did it produce better questions or better answers?

For memory-only campaigns:

- Was a memory candidate accepted, rejected, or deferred?
- Did it generate a better follow-up question?

For predictions:

- Did the target event resolve?
- Is more time required?

Day 30 outcomes update:

- question usefulness
- answer usefulness
- contributor reputation eligibility
- intervention effectiveness

### Day 31-90: Iterate

Atlas may:

- improve the intervention.
- ask a follow-up campaign.
- retire the idea.
- expand a skill.
- publish progress updates.
- gather direct feedback.

The goal is to learn whether the campaign produced durable value, not merely a
one-time artifact.

### Day 90: Final Label

Atlas records the final v1 label:

- Did this line of inquiry matter?
- Did the intervention remain useful?
- Did the world model improve?
- Did the contributor's answer prove useful, misleading, or unverifiable?
- Should the question pattern be reused?
- Should reputation change?

Day 90 is the strongest reputation update checkpoint.

## Campaign Types

### Discovery Campaign

Expected actions:

- `memory_update`
- `follow_up_question`

Goal: learn what is worth asking or remembering.

### Decision Campaign

Expected actions:

- `run_experiment`
- `build_tool`
- `build_skill`

Goal: choose between concrete actions.

### Diagnostic Campaign

Expected actions:

- `run_experiment`
- `follow_up_question`

Goal: understand why something happened or failed.

### Procedural Campaign

Expected actions:

- `build_skill`
- `run_experiment`

Goal: define a process Atlas can execute and evaluate.

### Evaluation Campaign

Expected actions:

- `memory_update`
- `run_experiment`

Goal: judge whether an intervention worked.

### Prediction Campaign

Expected actions:

- `none`
- `run_experiment`

Goal: resolve a future claim only when the prediction informs Atlas action.

## Outcome Labels

Question-level labels:

- `produced_useful_answers`
- `produced_memory_candidate`
- `produced_follow_up_question`
- `produced_intervention`
- `intervention_used`
- `intervention_effective`
- `question_too_broad`
- `question_not_actionable`
- `question_pattern_reusable`

Answer-level labels:

- `cited_by_atlas`
- `used_in_candidate_memory`
- `used_in_intervention`
- `supported_by_later_outcome`
- `contradicted_by_later_outcome`
- `unverifiable`

Intervention-level labels:

- `built`
- `not_built`
- `used`
- `unused`
- `effective`
- `partially_effective`
- `ineffective`
- `retired`

## Guardrails

- Atlas should not build from every campaign.
- Every build/test intervention must be scoped as an experiment.
- Durable memory changes require citations to answer or claim records.
- Spending must obey treasury policy.
- High-impact tools require human review before public release.
- Reputation should update from behavioral and ground-truth outcomes, not raw
  engagement.

## Database Implications

Add or extend records:

- `questions.expected_action`
- `questions.success_test`
- `questions.resolution_target_at`
- `campaign_runs.lifecycle_stage`
- `interventions`
- `intervention_events`
- `outcome_checks`

Suggested job types:

- `campaign.collect`
- `campaign.synthesize_day_7`
- `intervention.plan`
- `intervention.build`
- `intervention.evaluate_day_30`
- `intervention.iterate`
- `campaign.final_label_day_90`

## Beta Mode

In beta mode:

- Day 7 synthesis writes candidate artifacts.
- Day 8-29 intervention planning may draft tool/skill specs.
- Atlas does not auto-release public products without operator approval.
- Day 30 and day 90 labels may be manual.
- Reputation updates remain internal.

The purpose of beta mode is to make the loop observable before granting Atlas
more autonomy.
