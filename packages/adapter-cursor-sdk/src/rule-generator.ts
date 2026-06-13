/**
 * RuleGenerator — 动态生成 .cursor/rules/ 下的 .mdc rule 文件
 *
 * 职责：
 *   1. 根据当前 phase 生成对应的 .mdc rule 文件（含 globs + content）
 *   2. 清理非当前 phase 的过期 rule 文件
 *   3. 始终维护 loop-cursor-global.mdc（alwaysApply: true，永不删除）
 *   4. 提供 Phase → globs → content 的完整映射表
 *
 * 文件命名约定：
 *   - Phase rule:  .cursor/rules/loop-cursor-phase-<phase_slug>.mdc
 *   - Global rule: .cursor/rules/loop-cursor-global.mdc
 *
 * 运行上下文：在每次 agent.send() 前由 SDK 引擎（非 agent）写入文件系统。
 *            agent 仅读取这些文件——SDK 引擎负责写入。
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ============================================================================
// 类型定义
// ============================================================================

/** Phase ID——与 state.json 的 progress.phase 字段一致 */
export type PhaseId =
  | "init"
  | "part_1_1"
  | "part_1_2"
  | "part_1_3"
  | "part_2_1"
  | "part_2_2"
  | "part_2_3"
  | "part_2_4"
  | "part_2_5"
  | "part_2_6"
  | "part_2_7"
  | "part_2_8"
  | "routing"
  | "complete"
  | "paused"
  | "failed";

/** .mdc 文件的 frontmatter 元数据 */
interface MdcFrontmatter {
  description: string;
  globs: string[];
  alwaysApply: boolean;
}

/** 单个 phase 的 .mdc rule 模板定义 */
interface PhaseRuleTemplate {
  phase: PhaseId;
  slug: string; // 用于文件名——将 phase ID 中的下划线转为连字符
  frontmatter: MdcFrontmatter;
  /** 生成 content 的函数——接收 artifacts 根路径，返回完整的 Markdown 内容 */
  content: (artifactsRoot: string) => string;
}

/** RuleGenerator 配置 */
interface RuleGeneratorConfig {
  /** .cursor/rules/ 目录的绝对路径 */
  rulesDir: string;
  /** artifacts/ 目录的相对路径（用于在 rule content 中引用） */
  artifactsRoot: string;
}

// ============================================================================
// Phase → globs 映射表
// ============================================================================

/**
 * globs 设计原则：
 *   - 空 globs 数组 = 不对文件作用域施加限制（init / global 阶段）
 *   - globs 限定 agent 的 Read/Write/Edit 操作范围
 *   - Part 1 阶段（设计气泡）仅需读写 .md 文件（需求/方案文档）
 *   - Part 2 阶段根据子 phase 不同，逐步扩大文件作用域
 */
const PHASE_TO_GLOBS: Record<PhaseId, string[]> = {
  init: [],
  part_1_1: ["*.md", ".cursor/loop-cursor/artifacts/**"],
  part_1_2: ["*.md", ".cursor/loop-cursor/artifacts/**"],
  part_1_3: ["*.md", ".cursor/loop-cursor/artifacts/**"],
  part_2_1: [".cursor/loop-cursor/artifacts/**", "*.md"],
  part_2_2: ["src/**", "tests/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_3: ["src/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_4: [".cursor/loop-cursor/artifacts/**", "*.md"],
  part_2_5: ["tests/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_6: ["tests/**", "src/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_7: ["src/**", "tests/**", ".cursor/loop-cursor/artifacts/**"],
  part_2_8: ["src/**", "tests/**", ".cursor/loop-cursor/artifacts/**"],
  routing: [],
  complete: [],
  paused: [],
  failed: [],
};

// ============================================================================
// Phase → 描述 映射表
// ============================================================================

const PHASE_DESCRIPTIONS: Record<PhaseId, string> = {
  init: "loop-cursor phase=init — Codebase exploration & state initialization",
  part_1_1: "loop-cursor phase=part_1_1 — Requirements clarification (Design Bubble)",
  part_1_2: "loop-cursor phase=part_1_2 — Direction research (Design Bubble)",
  part_1_3: "loop-cursor phase=part_1_3 — Solution formation (Design Bubble)",
  part_2_1: "loop-cursor phase=part_2_1 — Solution → Plan + Tasks breakdown",
  part_2_2: "loop-cursor phase=part_2_2 — Implementation",
  part_2_3: "loop-cursor phase=part_2_3 — Code Review",
  part_2_4: "loop-cursor phase=part_2_4 — E2E Test Strategy",
  part_2_5: "loop-cursor phase=part_2_5 — Test Planning",
  part_2_6: "loop-cursor phase=part_2_6 — Execute Tests",
  part_2_7: "loop-cursor phase=part_2_7 — Audit & Verification",
  part_2_8: "loop-cursor phase=part_2_8 — Hard Verification Gate",
  routing: "loop-cursor phase=routing — Internal routing (engine-only, no agent call)",
  complete: "loop-cursor phase=complete — Task completed",
  paused: "loop-cursor phase=paused — Task paused, awaiting user input",
  failed: "loop-cursor phase=failed — Task failed",
};

// ============================================================================
// Phase → slug 映射（用于文件名）
// ============================================================================

function phaseToSlug(phase: PhaseId): string {
  return phase.replace(/_/g, "-");
}

// ============================================================================
// 各 phase 的 rule content 模板
// ============================================================================

function buildInitContent(artifactsRoot: string): string {
  return `# Phase: init — Codebase Exploration & Initialization

## Role
You are loop-cursor's initialization agent. Your job is to explore the codebase, understand the project context, and initialize the state.

## Objectives
1. Explore the current directory structure using Bash tools (ls, find, git log, etc.)
2. Identify the project type, language, framework, and build system
3. Report your findings in a structured summary
4. Create the initial state.json if it does not exist (via Bash: echo '...' > .cursor/loop-cursor/state.json)

## Allowed Operations
- Read any file in the project
- Execute read-only Bash commands (ls, find, cat, git status, git log, node --version, python --version, etc.)
- Create .cursor/loop-cursor/state.json (only if it does not exist)
- Create git worktree via: git worktree add .cursor/loop-cursor/worktrees/impl-\$(date +%s)

## Forbidden Operations
- NO file modifications outside .cursor/loop-cursor/
- NO file deletions
- NO git push, git commit, git merge
- NO dependency installation
- NO PR creation

## Stop Condition
- You have explored the codebase AND
- Output <<<LOOP_STATE>>> block with phase set to "part_1_1" AND
- summary field contains your exploration findings

## Context
- User request: read from .cursor/loop-cursor/state.json → config.user_request
- Artifacts root: ${artifactsRoot}
`;
}

function buildPart1xContent(
  phase: PhaseId,
  phaseLabel: string,
  artifactsRoot: string,
): string {
  const phaseInstructions: Record<string, string> = {
    part_1_1: `## Objectives (part_1_1 — Requirements Clarification)
1. Read the user's request from state.json → config.user_request
2. Ask clarifying questions to disambiguate the requirements
3. Identify at least 3 potential ambiguities (encoding, format, edge cases, scope boundaries, NFRs)
4. For each ambiguity, propose reasonable assumptions and document them
5. Produce ${artifactsRoot}/01-requirements.md — a structured requirements document
   - Problem statement
   - Functional requirements (numbered, testable)
   - Non-functional requirements (performance, security, UX)
   - Out-of-scope items (explicitly listed)
   - Assumptions made (explicitly listed with rationale)
6. Self-check: Are there remaining ambiguities? If yes, iterate within this same agent.send() call`,
    part_1_2: `## Objectives (part_1_2 — Direction Research)
1. Read ${artifactsRoot}/01-requirements.md
2. Identify at least 2 viable technical directions/approaches
3. For each direction, evaluate:
   - Technical feasibility (with specific evidence)
   - Performance characteristics
   - Dependency footprint (new libraries needed?)
   - Maintenance burden
   - Alignment with existing codebase patterns
4. Produce ${artifactsRoot}/02-direction.md — a direction recommendation document
   - Each direction described with pros/cons/risks
   - Explicit recommendation with justification
   - Trade-offs acknowledged
5. Self-check: Is the recommended direction clearly superior? If not, iterate within this agent.send() call`,
    part_1_3: `## Objectives (part_1_3 — Solution Formation)
1. Read ${artifactsRoot}/01-requirements.md and ${artifactsRoot}/02-direction.md
2. Synthesize a concrete, executable solution
3. Produce ${artifactsRoot}/03-solution.md — a complete solution document:
   - Architecture overview (diagram in text/Mermaid)
   - Data flow: input → processing → output
   - Component/module breakdown with responsibilities
   - API/interface definitions (if applicable)
   - Error handling strategy
   - Testing strategy overview
   - Implementation phases/ordering
   - Any remaining uncertainties marked explicitly as "ASSUMPTION: ..."
4. Self-check: Could a developer implement this solution without asking further questions?
   If not, iterate within this agent.send() call`,
  };

  return `# Phase: ${phaseLabel} — Design Bubble

## Role
You are loop-cursor's design-phase agent operating within a single agent.send() call (the "Design Bubble").
Context is continuous within this call — you can iterate between sub-phases without losing information.

## Design Bubble Rules
- You WILL internally iterate: part_1_1 → part_1_2 → part_1_3 within this single agent.send() call
- You MAY backtrack: if 1.2 reveals the requirements in 1.1 were wrong, go back and fix 1.1
- You MUST produce ALL THREE artifact files before finishing:
  - ${artifactsRoot}/01-requirements.md
  - ${artifactsRoot}/02-direction.md
  - ${artifactsRoot}/03-solution.md
- If you reach max_part1_rounds (default 5) without convergence, mark remaining
  uncertainties as "ASSUMPTION" and proceed to output

${phaseInstructions[phase] || ""}

## Allowed Operations
- Read any .md file and artifacts under ${artifactsRoot}/
- Write .md files under ${artifactsRoot}/
- Read source files for context (to understand existing codebase)
- Execute read-only Bash commands for exploration

## Forbidden Operations
- NO source code modifications (src/, lib/, etc.)
- NO dependency installation
- NO git push, git commit, git merge
- NO file deletions outside artifacts/
- NO creation of files outside ${artifactsRoot}/ (except context-summary.md)

## Stop Condition (after ALL three sub-phases complete)
- ${artifactsRoot}/01-requirements.md exists and is non-trivial (>200 chars)
- ${artifactsRoot}/02-direction.md exists with at least 2 directions evaluated
- ${artifactsRoot}/03-solution.md exists and is actionable
- Output <<<LOOP_STATE>>> block with phase set to "part_2_1"

## Context Artifacts
- User request: state.json → config.user_request
- Previous context: ${artifactsRoot}/context-summary.md (if exists)
- Artifacts root: ${artifactsRoot}
`;
}

function buildPart21Content(artifactsRoot: string): string {
  return `# Phase: part_2_1 — Solution → Plan + Tasks

## Role
You are loop-cursor's planning agent. Your job is to break the solution into an executable plan with discrete, verifiable tasks.

## Objectives
1. Read ${artifactsRoot}/03-solution.md — the complete solution document
2. Decompose the solution into an ordered implementation plan
3. Produce ${artifactsRoot}/04-implementation-plan.md:
   - Implementation phases with dependencies
   - For each phase: what to build, expected files, acceptance criteria
   - Risk items and mitigation
   - Estimated effort per phase (T-shirt sizes: S/M/L/XL)
4. Produce ${artifactsRoot}/05-task-list.json — a structured task list:
   \`\`\`json
   {
     "tasks": [
       {
         "id": "T001",
         "phase": "implementation",
         "title": "...",
         "description": "...",
         "files_to_create": ["path/to/file.ts"],
         "files_to_modify": [],
         "dependencies": [],
         "acceptance_criteria": ["..."],
         "status": "pending",
         "effort": "S"
       }
     ],
     "metadata": {
       "total_tasks": 0,
       "generated_at": "...",
       "solution_ref": "03-solution.md"
     }
   }
   \`\`\`
5. Tasks must be: atomic, verifiable, dependency-ordered, and file-scoped

## Allowed Operations
- Read .md files and JSON artifacts under ${artifactsRoot}/
- Write ${artifactsRoot}/04-implementation-plan.md
- Write ${artifactsRoot}/05-task-list.json
- Read source files for context (understanding existing code)

## Forbidden Operations
- NO source code modifications
- NO dependency installation
- NO git operations beyond worktree creation
- NO PR creation

## Stop Condition
- ${artifactsRoot}/04-implementation-plan.md exists and covers all solution components
- ${artifactsRoot}/05-task-list.json exists and is valid JSON with at least 1 task
- Output <<<LOOP_STATE>>> block with phase set to "part_2_2"
`;
}

function buildPart22Content(artifactsRoot: string): string {
  return `# Phase: part_2_2 — Implementation

## Role
You are loop-cursor's implementation agent. Your job is to execute the task list from 05-task-list.json,
creating and modifying source files as specified.

## Objectives
1. Read ${artifactsRoot}/05-task-list.json — the ordered task list
2. Read ${artifactsRoot}/04-implementation-plan.md — the implementation plan
3. Read ${artifactsRoot}/03-solution.md — for architecture reference
4. Execute tasks in dependency order:
   a. For each pending task, create/modify the specified files
   b. After each task, verify the acceptance criteria are met
   c. Update task status in 05-task-list.json (pending → in_progress → completed)
   d. If a task fails, record the failure reason and continue to next independent task
5. After all tasks complete, generate ${artifactsRoot}/05b-implementation-diff.patch:
   \`\`\`bash
   git diff > ${artifactsRoot}/05b-implementation-diff.patch
   \`\`\`
6. If repair_context is set in state.json, ONLY fix the specific issues listed in issues.active
   and only modify the files listed in repair_context.affected_files

## Allowed Operations
- Write/Edit source files under src/
- Write/Edit test files under tests/
- Read any file under src/, tests/, ${artifactsRoot}/
- Execute build and test commands (Bash)
- Execute git add / git diff (but NOT git commit or git push)

## Forbidden Operations
- NO merge commits (git merge)
- NO PR creation (gh pr create)
- NO new git worktree creation
- NO pushing to remote (git push)
- NO modification of .cursor/loop-cursor/state.json
- NO modification of .cursor/loop-cursor/hooks/ files
- NO modification of .cursor/rules/ files

## Stop Condition
- All tasks in 05-task-list.json have status = "completed" (or "failed" with documented reason) AND
- ${artifactsRoot}/05b-implementation-diff.patch has been generated AND
- Output <<<LOOP_STATE>>> block with:
  - phase set to "part_2_3"
  - issues array reflecting any problems encountered during implementation

## Context Files
- Task list: ${artifactsRoot}/05-task-list.json
- Implementation plan: ${artifactsRoot}/04-implementation-plan.md
- Solution: ${artifactsRoot}/03-solution.md
`;
}

function buildPart23Content(artifactsRoot: string): string {
  return `# Phase: part_2_3 — Code Review

## Role
You are loop-cursor's code review agent. Critically review the implementation for correctness,
quality, and adherence to the solution design.

## Objectives
1. Read ${artifactsRoot}/05b-implementation-diff.patch — the complete implementation diff
2. Read ${artifactsRoot}/03-solution.md — the solution design to verify alignment
3. Review for:
   a. **Correctness**: Does the code implement what the solution specifies?
   b. **Completeness**: Are all tasks from 05-task-list.json actually done?
   c. **Code quality**: Naming, structure, error handling, edge cases, DRY violations
   d. **Security**: Input validation, injection risks, secret handling, auth checks
   e. **Performance**: Obvious bottlenecks, unnecessary allocations, N+1 queries
   f. **Maintainability**: Comments, complexity, coupling, testability
4. Produce ${artifactsRoot}/06-code-review.md:
   - Summary (overall assessment)
   - Findings (each with severity: P0/P1/P2, file:line, description, fix suggestion)
   - Approved files (files that pass review)
   - Flagged files (files that need rework)
   - Recommendation: APPROVED / CHANGES_REQUESTED

## Allowed Operations
- Read source files under src/
- Read test files under tests/
- Read artifacts under ${artifactsRoot}/
- Write ${artifactsRoot}/06-code-review.md
- Execute git diff / git show for context

## Forbidden Operations
- NO source code modifications (this is review, not fix)
- NO test modifications
- NO git push, git commit, git merge

## Stop Condition
- ${artifactsRoot}/06-code-review.md exists with clear findings AND
- Output <<<LOOP_STATE>>> block with:
  - phase set to "part_2_4"
  - issues populated with any P0/P1/P2 findings from the review
`;
}

function buildPart24Content(artifactsRoot: string): string {
  return `# Phase: part_2_4 — E2E Test Strategy

## Role
You are loop-cursor's test strategist. Research and define the end-to-end testing approach.

## Objectives
1. Read ${artifactsRoot}/03-solution.md — to understand what needs testing
2. Read ${artifactsRoot}/04-implementation-plan.md — to understand the system architecture
3. Read the implemented source code under src/ — to understand actual behavior
4. Determine the testing pyramid:
   - Unit test scope and coverage targets
   - Integration test scope (which modules interact?)
   - E2E test scope (full user journeys)
5. Produce ${artifactsRoot}/07-test-plan.md (initial strategy section):
   - Test framework recommendation (with justification)
   - Mock/stub strategy
   - Test data strategy
   - CI/CD integration notes
   - Coverage targets

## Allowed Operations
- Read source files under src/
- Read artifacts under ${artifactsRoot}/
- Write ${artifactsRoot}/07-test-plan.md
- Execute read-only exploration commands

## Forbidden Operations
- NO source code modifications
- NO test file creation (this is strategy, not implementation)
- NO git operations beyond read-only

## Stop Condition
- ${artifactsRoot}/07-test-plan.md exists with comprehensive test strategy AND
- Output <<<LOOP_STATE>>> block with phase set to "part_2_5"
`;
}

function buildPart25Content(artifactsRoot: string): string {
  return `# Phase: part_2_5 — Test Planning

## Role
You are loop-cursor's test planner. Convert the test strategy into a concrete, executable test plan.

## Objectives
1. Read ${artifactsRoot}/07-test-plan.md — the test strategy
2. Read ${artifactsRoot}/03-solution.md and the implemented source code
3. Design concrete test cases:
   - Unit tests: one per function/method, covering happy path + edge cases + error paths
   - Integration tests: component interaction scenarios
   - E2E tests: full user journey scenarios
4. Append to ${artifactsRoot}/07-test-plan.md:
   - Detailed test case list (ID, description, inputs, expected outputs, test type)
   - Test file mapping (which test file tests which source file)
   - Test execution order and dependencies
   - Mock/stub specifications

## Allowed Operations
- Read source files under src/
- Read test files under tests/
- Read artifacts under ${artifactsRoot}/
- Write/Append to ${artifactsRoot}/07-test-plan.md

## Forbidden Operations
- NO source code modifications
- NO test code creation (this is planning, not writing tests)
- NO git operations beyond read-only

## Stop Condition
- ${artifactsRoot}/07-test-plan.md contains detailed test case specifications AND
- Output <<<LOOP_STATE>>> block with phase set to "part_2_6"
`;
}

function buildPart26Content(artifactsRoot: string): string {
  return `# Phase: part_2_6 — Execute Tests

## Role
You are loop-cursor's test executor. Write and run the tests specified in the test plan.

## Objectives
1. Read ${artifactsRoot}/07-test-plan.md — the test cases to implement
2. Read the source code under src/ — the implementation to test
3. Write test files under tests/ according to the test plan
4. Execute all tests:
   a. Run unit tests
   b. Run integration tests
   c. Run E2E tests (if applicable)
5. Record results in ${artifactsRoot}/08-test-results.json:
   \`\`\`json
   {
     "summary": {
       "total": 0, "passed": 0, "failed": 0, "skipped": 0,
       "duration_ms": 0, "coverage_percent": 0
     },
     "test_runs": [
       {
         "test_id": "UT-001",
         "test_file": "tests/test_foo.py",
         "test_name": "test_add_positive_numbers",
         "status": "pass",
         "duration_ms": 12,
         "error_message": null
       }
     ],
     "coverage": { "lines": 0, "branches": 0, "functions": 0 }
   }
   \`\`\`
6. If tests fail, diagnose the root cause:
   - Test bug → fix the test
   - Implementation bug → record as issue in issues.active
   - Environment issue → document and skip

## Allowed Operations
- Write/Edit test files under tests/
- Read source files under src/ (for understanding, NOT for modification)
- Read artifacts under ${artifactsRoot}/
- Execute test commands (Bash)
- Write ${artifactsRoot}/08-test-results.json

## Forbidden Operations
- NO modification of source files under src/ (test failures → record as issues, don't fix here)
- NO git push, git commit, git merge
- NO dependency installation (use pre-installed test framework)

## Stop Condition
- Test files created and executed AND
- ${artifactsRoot}/08-test-results.json exists with results AND
- Output <<<LOOP_STATE>>> block with:
  - phase set to "part_2_7"
  - issues reflecting any test failures that indicate implementation bugs
`;
}

function buildPart27Content(artifactsRoot: string): string {
  return `# Phase: part_2_7 — Audit & Verification

## Role
You are loop-cursor's audit agent. Systematically verify all artifacts and identify any remaining gaps.

## Objectives
1. Audit all artifacts for completeness and consistency:
   a. Cross-reference 03-solution.md ↔ 04-implementation-plan.md ↔ 05-task-list.json
      (does the plan cover all solution components? Are all tasks accounted for?)
   b. Cross-reference 05-task-list.json ↔ source files (are all tasks actually implemented?)
   c. Cross-reference 06-code-review.md findings (have all been addressed?)
   d. Cross-reference 08-test-results.json (are all critical paths tested?)
2. Produce ${artifactsRoot}/09-issue-list.json:
   \`\`\`json
   {
     "issues": [
       {
         "id": "ISS-001",
         "severity": "P0|P1|P2",
         "category": "missing_feature|bug|test_gap|doc_gap|security|performance",
         "title": "...",
         "description": "...",
         "affected_files": ["path/to/file"],
         "detected_in_phase": "part_2_7",
         "status": "open"
       }
     ],
     "summary": {
       "total_open": 0,
       "by_severity": {"p0": 0, "p1": 0, "p2": 0}
     }
   }
   \`\`\`
3. Verify that no P0 issues remain open before proceeding

## Allowed Operations
- Read all source files under src/
- Read all test files under tests/
- Read all artifacts under ${artifactsRoot}/
- Write ${artifactsRoot}/09-issue-list.json
- Execute read-only verification commands

## Forbidden Operations
- NO source code modifications (find, don't fix)
- NO test modifications
- NO git operations beyond read-only

## Stop Condition
- ${artifactsRoot}/09-issue-list.json exists with comprehensive audit results AND
- Output <<<LOOP_STATE>>> block with:
  - phase set to "part_2_8"
  - issues populated with all findings from the audit
`;
}

function buildPart28Content(artifactsRoot: string): string {
  return `# Phase: part_2_8 — Hard Verification Gate

## Role
You are loop-cursor's final verification agent. This is the LAST gate before completion declaration.
You must produce IRREFUTABLE EVIDENCE that the task is complete.

## Objectives
1. Verify the DELIVERABLE (the thing the user asked for):
   a. Does the final output match the user's original request?
   b. Run the application/script/tool end-to-end
   c. Capture actual output as evidence
2. Verify the QUALITY:
   a. Re-run ALL tests from 08-test-results.json — confirm 100% pass
   b. Run linting/static analysis if configured
   c. Verify no regression: diff against baseline if applicable
3. Verify the ARTIFACTS chain:
   a. requirements → solution → plan → tasks → implementation → review → tests
   b. Every artifact references the next correctly
   c. No broken links in the artifact chain
4. Produce ${artifactsRoot}/10-verification.md:
   - Verification checklist (each item with PASS/FAIL and evidence)
   - Test re-run output (copy-pasted)
   - Application output (copy-pasted)
   - Any remaining issues (must be empty for completion)
   - Final verdict: READY_FOR_COMPLETION / NEEDS_FIX

## Allowed Operations
- Read all source files under src/
- Read all test files under tests/
- Read all artifacts under ${artifactsRoot}/
- Execute verification commands (Bash): run app, run tests, lint, etc.
- Write ${artifactsRoot}/10-verification.md

## Forbidden Operations
- NO source code modifications
- NO test modifications
- NO artifact modifications (this is read-and-verify, not fix)
- NO git operations beyond read-only

## Stop Condition
- ${artifactsRoot}/10-verification.md exists with ALL checklist items verified AND
- Output <<<LOOP_STATE>>> block with:
  - phase set to "routing"
  - issues set to empty arrays if verification passed, or populated with findings
  - summary containing the final verdict

## CRITICAL
If ANY verification item fails, you MUST report it as an issue in the LOOP_STATE block.
Do NOT fix issues — the routing engine will decide whether to loop back or terminate.
`;
}

function buildGlobalContent(): string {
  return `# loop-cursor Global Guardrails — ALWAYS ACTIVE

## IMMUTABLE RULES (do not bypass, do not negotiate)

1. **NEVER modify** .cursor/loop-cursor/state.json directly.
   State updates are handled by the loop-cursor SDK engine.
2. **NEVER modify** .cursor/loop-cursor/hooks/*.ts files.
   Hook scripts are compiled and immutable.
3. **NEVER modify** .cursor/rules/loop-cursor-*.mdc files.
   Rule files are generated by the loop-cursor SDK engine.
4. **NEVER create PR or merge** — loop-cursor manages git workflow.
   Use \`git add\` and \`git diff\` but never \`git commit\`, \`git merge\`, or \`gh pr create\`.
5. **NEVER push** to any remote — loop-cursor manages git workflow.
   \`git push\` is always forbidden.
6. **ALWAYS append** context to context-summary.md at the end of each phase.
   After completing a phase, update .cursor/loop-cursor/artifacts/context-summary.md.
7. **ALWAYS output** \\<\\<\\<LOOP_STATE>>> block at the end of each turn.
   Format: a JSON object with phase, issues (p0/p1/p2 arrays), and summary fields.

## PHASE-AWARE BEHAVIOR

Check current phase in .cursor/loop-cursor/state.json → progress.phase.
Apply the corresponding phase rule file (.cursor/rules/loop-cursor-phase-*.mdc).

## SAFETY OVERRIDES

- Catastrophic commands (rm -rf /, mkfs, dd to /dev, DROP TABLE, force push main/master) are
  HARD-BLOCKED at the OS level by hooks.json beforeShellExecution — they CANNOT be bypassed.
- Path protection: .cursor/loop-cursor/state.json, hooks/, rules/ are write-protected at the
  filesystem level by hooks.json preToolUse matchers.

## OUTPUT FORMAT REQUIREMENT

Every agent response MUST end with a <<<LOOP_STATE>>> block:

\`\`\`
<<<LOOP_STATE>>>
{
  "phase": "<current_or_next_phase>",
  "issues": {
    "p0": [{"id":"...", "title":"...", "file":"..."}],
    "p1": [],
    "p2": []
  },
  "summary": "<one-sentence summary of what was accomplished this turn>"
}
<<<END_LOOP_STATE>>>
\`\`\`

This block is MANDATORY — the SDK engine parses it to drive state transitions.
Without it, the engine cannot determine the next phase.
`;
}

// ============================================================================
// Phase → content 生成函数的映射表
// ============================================================================

type ContentBuilder = (artifactsRoot: string) => string;

const PHASE_CONTENT_BUILDERS: Record<PhaseId, ContentBuilder> = {
  init: (root) => buildInitContent(root),
  part_1_1: (root) => buildPart1xContent("part_1_1", "part_1_1", root),
  part_1_2: (root) => buildPart1xContent("part_1_2", "part_1_2", root),
  part_1_3: (root) => buildPart1xContent("part_1_3", "part_1_3", root),
  part_2_1: (root) => buildPart21Content(root),
  part_2_2: (root) => buildPart22Content(root),
  part_2_3: (root) => buildPart23Content(root),
  part_2_4: (root) => buildPart24Content(root),
  part_2_5: (root) => buildPart25Content(root),
  part_2_6: (root) => buildPart26Content(root),
  part_2_7: (root) => buildPart27Content(root),
  part_2_8: (root) => buildPart28Content(root),
  routing: (_root) => "",
  complete: (_root) => "",
  paused: (_root) => "",
  failed: (_root) => "",
};

// ============================================================================
// RuleGenerator 主类
// ============================================================================

export class RuleGenerator {
  private readonly config: Required<RuleGeneratorConfig>;

  /** 所有规则文件名的前缀 */
  private static readonly RULE_PREFIX = "loop-cursor-phase-";
  /** 全局规则文件名 */
  private static readonly GLOBAL_RULE = "loop-cursor-global";

  /** 需要生成 rule 文件的 phase 列表（routing/complete/paused/failed 不生成） */
  private static readonly GENERATABLE_PHASES: PhaseId[] = [
    "init",
    "part_1_1",
    "part_1_2",
    "part_1_3",
    "part_2_1",
    "part_2_2",
    "part_2_3",
    "part_2_4",
    "part_2_5",
    "part_2_6",
    "part_2_7",
    "part_2_8",
  ];

  constructor(config: RuleGeneratorConfig) {
    this.config = {
      rulesDir: config.rulesDir,
      artifactsRoot: config.artifactsRoot,
    };
  }

  // ==========================================================================
  // 公开 API
  // ==========================================================================

  /**
   * 生成当前 phase 对应的 .mdc rule 文件，并写入文件系统。
   *
   * 这是 injectGuardrails() 的核心调用——在每次 agent.send() 前执行。
   *
   * @param phase 当前 phase ID
   * @returns 写入的 rule 文件路径
   */
  generate(phase: PhaseId): string {
    const rulePath = this.getRulePath(phase);
    const content = this.buildRuleContent(phase);

    this.ensureRulesDir();
    fs.writeFileSync(rulePath, content, "utf-8");

    return rulePath;
  }

  /**
   * 写入全局护栏 rule（loop-cursor-global.mdc）。
   * 全局 rule 的 alwaysApply=true，在所有 phase 生效。
   *
   * @returns 全局 rule 文件路径
   */
  generateGlobal(): string {
    const rulePath = path.join(
      this.config.rulesDir,
      `${RuleGenerator.GLOBAL_RULE}.mdc`,
    );
    const frontmatter = this.buildGlobalFrontmatter();
    const content = buildGlobalContent();
    const fullContent = this.assembleRuleFile(frontmatter, content);

    this.ensureRulesDir();
    fs.writeFileSync(rulePath, fullContent, "utf-8");

    return rulePath;
  }

  /**
   * 清理非当前 phase 的过期 .mdc rule 文件。
   * 保留：
   *   - 当前 phase 的 rule 文件
   *   - loop-cursor-global.mdc（alwaysApply: true，永不删除）
   *   - 非 loop-cursor 前缀的文件（用户自己的 rule 文件）
   *
   * @param currentPhase 当前 phase
   * @returns 被删除的文件路径列表
   */
  cleanup(currentPhase: PhaseId): string[] {
    if (!fs.existsSync(this.config.rulesDir)) {
      return [];
    }

    const currentRuleName = `${RuleGenerator.RULE_PREFIX}${phaseToSlug(currentPhase)}.mdc`;
    const globalRuleName = `${RuleGenerator.GLOBAL_RULE}.mdc`;
    const deleted: string[] = [];

    const entries = fs.readdirSync(this.config.rulesDir);
    for (const entry of entries) {
      // 跳过非 loop-cursor 前缀的文件
      if (
        !entry.startsWith(RuleGenerator.RULE_PREFIX) &&
        entry !== globalRuleName
      ) {
        continue;
      }

      // 保留当前 phase 的 rule
      if (entry === currentRuleName) {
        continue;
      }

      // 保留全局 rule
      if (entry === globalRuleName) {
        continue;
      }

      const fullPath = path.join(this.config.rulesDir, entry);
      try {
        fs.unlinkSync(fullPath);
        deleted.push(fullPath);
      } catch (err) {
        // 文件可能已被外部删除——记录但不抛出
        console.warn(
          `[RuleGenerator] Failed to delete stale rule ${fullPath}: ${(err as Error).message}`,
        );
      }
    }

    return deleted;
  }

  /**
   * 生成所有 12 个 phase + 1 个 global 的 rule 文件（共 13 个）。
   * 用于首次初始化或 --regenerate-rules 场景。
   *
   * @returns 生成的文件路径列表
   */
  generateAll(): string[] {
    const generated: string[] = [];

    // 生成所有 phase rules
    for (const phase of RuleGenerator.GENERATABLE_PHASES) {
      generated.push(this.generate(phase));
    }

    // 生成 global rule
    generated.push(this.generateGlobal());

    return generated;
  }

  /**
   * 返回指定 phase 的 rule 文件路径（不保证文件存在）。
   */
  getRulePath(phase: PhaseId): string {
    return path.join(
      this.config.rulesDir,
      `${RuleGenerator.RULE_PREFIX}${phaseToSlug(phase)}.mdc`,
    );
  }

  /**
   * 返回全局 rule 文件路径。
   */
  getGlobalRulePath(): string {
    return path.join(
      this.config.rulesDir,
      `${RuleGenerator.GLOBAL_RULE}.mdc`,
    );
  }

  /**
   * 获取指定 phase 的 globs 数组。
   */
  getGlobsForPhase(phase: PhaseId): string[] {
    return PHASE_TO_GLOBS[phase] ?? [];
  }

  /**
   * 列出所有可生成的 phase。
   */
  listGeneratablePhases(): PhaseId[] {
    return [...RuleGenerator.GENERATABLE_PHASES];
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  /** 确保 .cursor/rules/ 目录存在 */
  private ensureRulesDir(): void {
    if (!fs.existsSync(this.config.rulesDir)) {
      fs.mkdirSync(this.config.rulesDir, { recursive: true });
    }
  }

  /** 为指定 phase 构建完整的 .mdc rule 文件内容 */
  private buildRuleContent(phase: PhaseId): string {
    const frontmatter = this.buildFrontmatter(phase);
    const contentBuilder = PHASE_CONTENT_BUILDERS[phase];
    const content = contentBuilder
      ? contentBuilder(this.config.artifactsRoot)
      : `# Phase: ${phase}\n\nNo rule content defined for this terminal phase.\n`;
    return this.assembleRuleFile(frontmatter, content);
  }

  /** 构建 frontmatter YAML */
  private buildFrontmatter(phase: PhaseId): MdcFrontmatter {
    return {
      description:
        PHASE_DESCRIPTIONS[phase] ?? `loop-cursor phase=${phase}`,
      globs: PHASE_TO_GLOBS[phase] ?? [],
      alwaysApply: false,
    };
  }

  /** 构建全局 rule 的 frontmatter */
  private buildGlobalFrontmatter(): MdcFrontmatter {
    return {
      description: "loop-cursor global guardrails — ALWAYS ACTIVE",
      globs: [],
      alwaysApply: true,
    };
  }

  /** 将 frontmatter 序列化为 YAML 格式的字符串 */
  private serializeFrontmatter(fm: MdcFrontmatter): string {
    const lines: string[] = [];
    lines.push("---");
    lines.push(`description: "${fm.description}"`);
    if (fm.globs.length > 0) {
      lines.push("globs:");
      for (const g of fm.globs) {
        lines.push(`  - "${g}"`);
      }
    } else {
      lines.push("globs: []");
    }
    lines.push(`alwaysApply: ${fm.alwaysApply}`);
    lines.push("---");
    return lines.join("\n");
  }

  /** 组合 frontmatter + content 为完整的 .mdc 文件内容 */
  private assembleRuleFile(fm: MdcFrontmatter, content: string): string {
    const fmStr = this.serializeFrontmatter(fm);
    return `${fmStr}\n\n${content.trim()}\n`;
  }
}

// ============================================================================
// 便捷工厂函数
// ============================================================================

/**
 * 使用默认路径创建 RuleGenerator 实例。
 *
 * 默认规则：rulesDir = ".cursor/rules", artifactsRoot = ".cursor/loop-cursor/artifacts"
 */
export function createRuleGenerator(
  projectRoot?: string,
): RuleGenerator {
  const base = projectRoot ?? process.cwd();
  return new RuleGenerator({
    rulesDir: path.join(base, ".cursor", "rules"),
    artifactsRoot: ".cursor/loop-cursor/artifacts",
  });
}

// ============================================================================
// 导出映射表（供外部直接引用）
// ============================================================================

export { PHASE_TO_GLOBS, PHASE_DESCRIPTIONS, PHASE_CONTENT_BUILDERS };
