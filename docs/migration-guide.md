# Migration Guide — OpenClaw Memory Stack

How to bring your existing memories, notes, and context into the Memory Stack.

## From manual markdown notes

If you keep project notes as `.md` files in your repo or a separate folder, you can import them into both backends.

### Into Total Recall

Total Recall stores memories as markdown files on a git orphan branch. You can bulk-import your notes:

```bash
cd /path/to/your/project

# Switch to the memory branch
git checkout openclaw-memory

# Copy your notes into the memory directory with timestamped names
for file in /path/to/your/notes/*.md; do
  BASENAME=$(basename "$file" .md)
  SLUG=$(echo "$BASENAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | tr -cd 'a-z0-9-')
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
  cp "$file" "_memory/${TIMESTAMP}_${SLUG}.md"
done

# Stage and commit
git add _memory/
git commit -m "memory: bulk-import — migrated manual markdown notes"

# Return to working branch
git checkout main
```

If your notes do not have YAML frontmatter, consider adding it for better retrieval:

```yaml
---
key: note-slug
timestamp: 2026-03-17T00:00:00Z
tags: [imported, architecture]
---
```

This is optional but makes `git log --grep` searches more precise.

### Into QMD

QMD indexes files on disk. If your notes are in a folder, just create a collection pointing at them:

```bash
qmd collection add mynotes --pattern "**/*.md" --path /path/to/your/notes
qmd embed mynotes
qmd context add -c mynotes "Imported project notes covering architecture and design decisions"
```

Now `qmd search`, `qmd vsearch`, and `qmd query` will include these notes in results.

## From .claude/memory

If you have been using Claude Code's built-in memory files (`.claude/memory` or similar), those are typically plain text or markdown files stored in your project.

### Step 1: Locate existing memories

```bash
# Common locations
ls -la .claude/memory 2>/dev/null
ls -la .claude/CLAUDE.md 2>/dev/null
ls -la .cursorrules 2>/dev/null
```

### Step 2: Import into Total Recall

```bash
cd /path/to/your/project
git checkout openclaw-memory

# Import each memory file
for file in .claude/memory/*; do
  if [[ -f "$file" ]]; then
    BASENAME=$(basename "$file" | tr -cd 'a-z0-9-')
    TIMESTAMP=$(date -u +"%Y-%m-%dT%H-%M-%S")
    cp "$file" "_memory/${TIMESTAMP}_claude-${BASENAME}.md"
  fi
done

git add _memory/
git commit -m "memory: claude-import — migrated .claude/memory files"
git checkout main
```

### Step 3: Index with QMD (optional)

If you want QMD to also search these memories, you have two options:

**Option A** -- Index the memory branch files by checking them out in a worktree:

```bash
git worktree add /tmp/openclaw-mem openclaw-memory
qmd collection add project-memory --pattern "_memory/**/*.md" --path /tmp/openclaw-mem
qmd embed project-memory
```

**Option B** -- Index the original `.claude/memory` directory directly (if you want to keep it around):

```bash
qmd collection add claude-memory --pattern "**/*" --path /path/to/project/.claude/memory
qmd embed claude-memory
```

## From other tools

The general approach for any source:

1. **Export to files.** Get your memories/notes into individual files on disk (markdown preferred, plain text works).
2. **Import into Total Recall** using the bulk-import pattern above.
3. **Index with QMD** by creating a collection pointing at the files.

The key principle: Total Recall stores content on a git branch (durable, versioned). QMD indexes content on disk (searchable, fast). You can use both simultaneously -- the router will pick the right one per query.

## Switching between backends

You do not need to choose one backend. The memory router handles dispatch automatically based on query type:

- **Exact symbol/name lookup** goes to QMD (`search` mode)
- **Concept/behavior questions** go to QMD (`vsearch` mode)
- **Recent context recall** goes to Total Recall
- **Ambiguous queries** go to QMD (`query` mode) with Total Recall as fallback

If a backend returns weak results (relevance < 0.4), the router falls back to the next backend in the chain. You do not need to manually specify which backend to use.

### Storing in both backends

When you store a memory:

- **Total Recall** preserves the full content on the git branch (permanent, versioned).
- **QMD** indexes files on disk (fast search, but the index needs updating after changes).

For maximum coverage, store important decisions and context in Total Recall (durable) and keep your source files indexed in QMD (searchable). The router combines both at query time.

## Preserving history

Total Recall stores memories as git commits on the `openclaw-memory` branch. This means:

- Every memory is versioned. You can see the full history with `git log openclaw-memory`.
- Nothing is ever truly deleted unless you force-push or rewrite history.
- You can view any past state of any memory: `git show <commit>:_memory/<filename>`.
- The branch travels with your repo when you push/pull (if you push it to remote).

QMD's index is local and regenerable. If the index is lost or corrupted, rebuild it:

```bash
qmd embed <collection-name>
```

The source files are untouched -- QMD only reads them.

## Rollback

If the migration does not work out or you want to undo it:

### Undo Total Recall import

Remove the import commit:

```bash
git checkout openclaw-memory

# See recent commits
git log --oneline -10

# Revert the import commit (creates a new commit that undoes it)
git revert <commit-hash-of-import>

git checkout main
```

This is safe -- `git revert` creates a new commit rather than rewriting history.

If you want to remove the memory branch entirely:

```bash
git branch -D openclaw-memory
```

This deletes all memories on that branch. Use with caution.

### Undo QMD import

Remove the collection:

```bash
qmd collection remove <collection-name>
```

This deletes the index only. Your source files are not affected.

### Revert to previous tool

The Memory Stack does not modify your original memory files. Your `.claude/memory` directory, manual notes, or any other source remains untouched after migration. If you want to go back to your previous setup, just stop using the Memory Stack -- nothing else needs to change.
