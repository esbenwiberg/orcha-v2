import type { Task } from '../domain/task-types.js';

function screenshotSection(screenshots: string[]): string {
  if (screenshots.length === 0) return '';
  return `

## Screenshots

The following screenshots are attached — use your Read tool to view them:
${screenshots.map((p) => `- ${p}`).join('\n')}`;
}

export function buildInvestigationPrompt(task: Task): string {
  return `You are an expert software engineer evaluating whether a proposed task is worth implementing.

## Task
**Title**: ${task.title}

**Description**:
${task.description}
${screenshotSection(task.screenshots)}
## Instructions

1. Explore the codebase thoroughly — read relevant files, understand the architecture and conventions.
2. Search the web if the idea involves external technologies, libraries, or patterns you need to evaluate.
3. Evaluate the idea honestly along these dimensions:
   - **Feasibility**: Is this technically possible given the current architecture?
   - **Complexity**: How much work is involved? What's the blast radius?
   - **Impact**: Does this meaningfully improve the project?
   - **Conflicts**: Does it clash with existing patterns, features, or in-progress work?
   - **Duplication**: Does this (or something similar) already exist?

4. Be honest — reject bad ideas early to save execution cost. Don't be a yes-machine.

## Output

**CRITICAL**: Your ENTIRE final response must be a single JSON object — no prose, no markdown fences, no explanation before or after. Just the JSON object.

Rating scale:
- "reject": Bad idea — conflicts with codebase, already exists, or actively harmful
- "weak": Significant issues that need major rethinking before proceeding
- "viable": Could work, some concerns to address during implementation
- "good": Solid idea with a clear implementation path
- "excellent": High impact and straightforward to implement

JSON schema:

{"rating":"reject|weak|viable|good|excellent","summary":"2-3 sentence verdict","reasoning":"Detailed analysis paragraph","pros":["advantage 1"],"cons":["concern 1"],"filesExamined":["path/to/file.ts"],"webResearch":"Summary of web findings, if any"}`;
}

export function buildEnrichmentPrompt(task: Task): string {
  const investigationContext = task.investigationResult
    ? `
## Investigation Results

**Rating**: ${task.investigationResult.rating}
**Summary**: ${task.investigationResult.summary}

**Reasoning**: ${task.investigationResult.reasoning}

**Pros**: ${task.investigationResult.pros.join(', ')}
**Cons**: ${task.investigationResult.cons.join(', ')}

**Files examined**: ${task.investigationResult.filesExamined.join(', ')}
${task.investigationResult.webResearch ? `\n**Web research**: ${task.investigationResult.webResearch}` : ''}`
    : '';

  return `You are an expert software engineer preparing a detailed, actionable task specification from a rough idea.

## Original Idea
**Title**: ${task.title}

**Description**:
${task.description}
${screenshotSection(task.screenshots)}${investigationContext}

## Instructions

1. Deep-read the files identified during investigation (and related files: tests, configs, types).
2. Understand the project's patterns, conventions, and architecture from the actual code.
3. Rewrite the rough idea into a detailed, self-contained task description that another agent can execute with no additional context.
4. Map every affected file with the type of change and reason.
5. Produce a step-by-step implementation approach.
6. Identify risks with severity and mitigation strategies.
7. Define concrete acceptance criteria.

**Rules**:
- Read the actual code, don't guess — cite specific files and line numbers.
- Follow the codebase's existing conventions and patterns.
- Think about edge cases, error handling, and test coverage.
- Estimate complexity honestly.

## Output

**CRITICAL**: Your ENTIRE final response must be a single JSON object — no prose, no markdown fences, no explanation before or after. Just the JSON object.

JSON schema:

{"improvedDescription":"Detailed rewrite","affectedFiles":[{"path":"src/foo.ts","reason":"why","changeType":"modify|create|delete"}],"approach":[{"step":1,"description":"What to do","files":["src/foo.ts"]}],"risks":[{"description":"What could go wrong","severity":"low|medium|high","mitigation":"How to mitigate"}],"complexity":"trivial|small|medium|large","acceptanceCriteria":["Criterion 1"],"relatedCode":[{"path":"src/bar.ts","lines":"42-58","relevance":"Why this matters"}]}`;
}

export function buildExecutionPrompt(task: Task): string {
  const description = task.enrichedDescription ?? task.description;

  let prompt = `## Task
**Title**: ${task.title}

${description}
${screenshotSection(task.screenshots)}`;

  if (task.enrichmentResult) {
    const er = task.enrichmentResult;
    prompt += `

## Implementation Approach
${er.approach.map((s) => `${s.step}. ${s.description}\n   Files: ${s.files.join(', ')}`).join('\n')}

## Affected Files
${er.affectedFiles.map((f) => `- \`${f.path}\` (${f.changeType}): ${f.reason}`).join('\n')}

## Acceptance Criteria
${er.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}

## Risks
${er.risks.map((r) => `- **${r.severity}**: ${r.description} — Mitigation: ${r.mitigation}`).join('\n')}`;
  }

  // Verification suffix (always included)
  prompt += `

## Self-Verification

Before creating the PR, audit your own work:

1. Re-read the task requirements (original + enriched description)
2. Verify every acceptance criterion is met
3. Run any relevant build/test commands
4. Check for:
   - Missing error handling at system boundaries
   - Untested edge cases
   - Files you changed but didn't save
   - Import statements that reference non-existent modules
5. If anything is incomplete, fix it before continuing`;

  // Self-validate — runs BEFORE PR creation so the preview URL can be included
  if (task.selfValidate) {
    prompt += `

## Post-Implementation Validation (REQUIRED)

You MUST validate the running application before creating the PR. This is not optional.

1. Call \`validate_start\` to host the application — note the preview URL it returns
2. Call \`validate_browse\` with path "/" to verify the main page loads without errors
3. Call \`validate_browse\` for each page affected by your changes
4. Call \`validate_screenshot\` to capture visual proof of the working state
5. If you find issues, fix them, re-build, and re-validate

Save the preview URL — you will include it in the PR description below.
Leave the validation environment running — it will auto-stop after timeout.`;
  }

  // PR creation instructions
  if (task.reviewFeedback) {
    prompt += `

## Review Feedback to Address

The following review comments were left on the PR. Address ALL of them:

${task.reviewFeedback}

## After Fixing

1. Commit your fixes with a message like "fix: address review feedback"
2. Push the branch (this auto-updates the PR)
3. Post a comment on the PR summarizing what you fixed using:
   \`gh pr comment ${task.prUrl?.match(/pull\/(\d+)/)?.[1] ?? ''} --body "your summary"\`
   Start the comment with a clear summary of changes made.`;
  } else {
    prompt += `

## Pull Request

After completing the implementation${task.selfValidate ? ' and validation' : ''}:
1. Commit all changes with a clear, descriptive commit message
2. Push the branch to the remote
3. Create a PR using \`gh pr create\` with:
   - A concise title summarizing the change
   - A description that explains what was done and why
   - Reference the acceptance criteria in the PR body${task.selfValidate ? `
   - Include a "## Preview" section with the preview URL from validate_start and any validation findings` : ''}`;
  }

  return prompt;
}

/** Allowed tools for the investigation phase (read + web). */
export const INVESTIGATION_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';

/** Allowed tools for the enrichment phase (read-only codebase). */
export const ENRICHMENT_TOOLS = 'Read,Glob,Grep';
