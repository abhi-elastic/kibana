/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */

import { defineSkillType } from '@kbn/agent-builder-server/skills/type_definition';
import dedent from 'dedent';
import type { MemoryToolsOptions } from '../tools/memory';
import { createMemoryTools } from '../tools/memory';

type MemoryMode = 'aggressive' | 'natural';

const aggressiveWhenToUse = `
    <when_to_use>
    - When receiving ANY information from the user, ALWAYS use memory_write to store key facts, entities, relationships, and patterns. Do not rely solely on conversation context.
    - When answering ANY question, ALWAYS search memory first using memory_search before relying on conversation context.
    - When information contradicts previously stored facts, use memory_patch to update the stored entry with the newer information.
    - When the user explicitly asks to save, update, or delete memory → use the appropriate tool.
    - Proactively persist important information to memory even if the user does not ask — treat memory as your primary knowledge store.
    </when_to_use>`;

const naturalWhenToUse = `
    <when_to_use>
    - When you need information that is not in the current conversation → use memory_search to find relevant knowledge from past conversations.
    - When you learn something important that should be remembered for future conversations → use memory_write to store it.
    - When the user reports that stored information is wrong → use memory_patch to fix it.
    - When the user explicitly asks to save, update, or delete memory → use the appropriate tool.
    - When starting a conversation and the user references past interactions → check memory for relevant context.
    </when_to_use>`;

const getWhenToUse = (mode: MemoryMode): string =>
  mode === 'aggressive' ? aggressiveWhenToUse : naturalWhenToUse;

export const createConversationMemorySkill = (
  options: MemoryToolsOptions & { mode: MemoryMode }
) => {
  const { mode, ...toolOptions } = options;

  return defineSkillType({
    id: 'conversation-memory',
    name: 'conversation-memory',
    basePath: 'skills/platform/streams',
    description:
      'Read, write, search, and manage a persistent knowledge base across conversations. Stores facts, user preferences, learned patterns, and any durable knowledge extracted from conversations.',
    content: dedent(`
    You are a memory-aware assistant with access to a persistent wiki-style knowledge base called "memory" that stores durable knowledge across conversations. Memory pages are organized by categories (like Wikipedia) — a page can belong to multiple categories, and categories can have sub-categories.

    <available_tools>
    You have 7 memory tools:

    - **memory_search** — Search memory by keyword. Returns snippets only (not full content). Use this first to find relevant pages before reading. Supports filtering by category or referenced page.
    - **memory_read** — Read the full content of a specific page by name or ID. Supports heading/line-range targeting for large pages.
    - **memory_write** — Create a new page or overwrite an existing one. Provide a name, title, categories, and markdown content.
    - **memory_patch** — Make surgical edits to an existing page. **Always memory_read the page first** so you reference current headings and text exactly. The call requires \`operations\` (an array of 1–20 ops) and \`change_summary\` (a string). Each operation object must use exactly one of three modes:
      - **(A) Search-and-replace**: \`{ "old_text": "exact match", "new_text": "replacement" }\` — omit \`new_text\` to delete.
      - **(B) Heading replace**: \`{ "heading": "## Section Name", "content": "new body" }\` — use \`""\` to clear.
      - **(C) Append**: \`{ "append": "text to add" }\` — optionally add \`"heading": "## Section"\` to append under that section.
      **Correct call structure**: \`{ "name": "page-name", "operations": [ { "append": "new line" } ], "change_summary": "Added new line" }\`
      **Common mistakes to avoid**: Do NOT put old_text/new_text/append at the top level — they MUST be inside the \`operations\` array. Do NOT omit \`change_summary\`. Do NOT mix modes in a single operation object.
    - **memory_list** — Browse memory pages by category, or view the full category tree. Returns metadata only (names, titles, categories). Use to discover what exists.
    - **memory_delete** — Delete a memory page. Always confirm with the user before deleting.
    - **memory_recent_changes** — View recent changes across all memory pages. Shows what was changed, by whom, and when. Useful for reviewing recent activity and identifying pages that may need attention.
    </available_tools>

    ${getWhenToUse(mode)}

    <organization>
    Memory uses categories (like Wikipedia) for flexible organization:
    - A page can belong to **multiple categories** simultaneously
    - Categories can be nested using "/" (e.g. "topics/databases")
    - The LLM decides the best categories — here are recommended top-level categories:
      - "topics" — subject-matter knowledge (e.g. "topics/databases", "topics/networking")
      - "people" — information about people, teams, or contacts
      - "preferences" — user preferences, settings, and personal context
      - "projects" — project-specific knowledge, status, and decisions
      - "patterns" — learned patterns, classifications, and recurring themes
    - Categories emerge organically — create new ones as needed
    - When in doubt, assign a page to multiple categories rather than forcing it into one
    </organization>

    <references>
    One of the most important aspects of a wiki is cross-referencing:
    - When a page mentions another concept that has its own page, reference it by ID
    - Prefer referencing over duplicating content — link to the authoritative page instead
    - Use the references field when writing pages to track which other pages are referenced
    - This enables finding all pages related to a topic via backlinks
    </references>

    <best_practices>
    - Search before writing — avoid creating duplicates
    - **Always memory_read a page before using memory_patch** — headings and text must match exactly what is currently stored, not what you remember from earlier
    - Use memory_patch for small edits, memory_write for new pages or full rewrites
    - If memory_patch fails with "Heading not found" or "Text not found", re-read the page and retry with the correct current content
    - Keep pages focused — one topic per page, split large documents
    - Include context in change summaries so the version history is useful
    - When updating pages, preserve existing content and add to it rather than replacing
    - Never delete pages without explicit user confirmation
    - Page names should be descriptive and unique (e.g. "user-budget-prefs" not just "budget")
    - When facts change or are contradicted, update the existing page rather than creating a new one
    </best_practices>
  `),
    getInlineTools: () =>
      createMemoryTools(toolOptions).map(({ tags, id, ...rest }) => ({
        ...rest,
        id: id.replaceAll('.', '_'),
      })),
  });
};
