---
sidebar_position: 2
---

# Comments and Annotations

Comment threads, review suggestions and similar annotations need to mark
ranges of text with an id. `@lexical/mark` offers two ways to store those
marks:

- [`MarkNode`](/docs/api/classes/lexical_mark.MarkNode), an inline
  `ElementNode` that wraps the marked text. This is the established API.
- [`MarkStateExtension`](/docs/api/modules/lexical_mark#markstateextension)
  (experimental), which stores each id as a [NodeState](/docs/concepts/node-state)
  key on the TextNodes, LineBreakNodes and inline DecoratorNodes it covers,
  with no wrapper element.

## When to use `MarkStateExtension`

Prefer it when marks overlap or when the document is edited collaboratively
with the Yjs **v2** binding (`CollaborationPluginV2__EXPERIMENTAL`).

- **Overlap.** Text covered by two comments is a single TextNode carrying
  both ids. With `MarkNode`, overlapping comments become sibling wrappers
  whose `ids` have to be kept consistent by the app (the playground uses
  `registerNestedElementResolver` for this), and without that they nest.
- **Concurrent edits.** Adding or removing an id only changes NodeState on
  the existing leaves (splitting a TextNode at the edges of the range). The
  v2 binding syncs TextNode NodeState as one Yjs text attribute per key, so
  these races between two peers merge correctly, each keeping the other's
  changes:
  - one types inside a range while the other comments on it;
  - both comment on the same, or overlapping, text;
  - one removes (or undoes) a comment while the other types inside it.

  With `MarkNode` the same races move or duplicate text, because wrapping
  or unwrapping text is a structural change that the bindings sync as a
  delete and a re-insert.

Keep using `MarkNode` when you need an element around the marked content
(for example to render it as a single DOM element), when you use the v1
binding, or when you depend on code that looks for `MarkNode`.

:::caution v1 collaboration

The v1 binding (`CollaborationPlugin`) syncs a TextNode split as a delete
and a re-insert of the text, so `MarkStateExtension` does not fix the races
above on v1: they behave like `MarkNode` (typed text can move to a different
position, concurrent comments can duplicate text). Only edits on text that is
already split at the right places, such as adding an id to an existing run,
merge correctly on v1.

:::

:::caution Three or more peers, paragraph merges

The races above are verified with two peers.

- With three or more peers editing the same paragraph concurrently (for
  example one removes a comment, one types inside it and one edits
  elsewhere in the paragraph), the v2 binding can extend a mark onto
  neighboring text, because it re-applies the text attributes of a whole
  paragraph from each peer's possibly stale view. This depends on a fix to
  the v2 binding that makes it write only the attributes that changed.
- When a comment races a paragraph merge (Backspace at the start of a
  paragraph the comment spans), the result depends on the order of the two
  edits: v2 syncs the merge as a delete and a re-insert of the second
  paragraph's text, so the mark can be dropped from that text or extended
  over it.

In both cases the peers still converge on the same document.

:::

## Usage

```ts
import {
  $addMarkID,
  $getMarkIDsAtSelection,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {buildEditorFromExtensions} from '@lexical/extension';
import {$getSelection, defineExtension} from 'lexical';

const editor = buildEditorFromExtensions(
  defineExtension({
    dependencies: [MarkStateExtension],
    name: 'my-editor',
    theme: {mark: 'comment', markOverlap: 'comment-overlap'},
  }),
);

editor.update(() => {
  const selection = $getSelection();
  if (selection) {
    $addMarkID(threadId, selection);
  }
});
// Remove the id everywhere (or pass a selection to remove it from a range)
editor.update(() => $removeMarkID(threadId));
// The ids at the caret, for example to open the matching thread
editor.read(() => $getMarkIDsAtSelection());
```

- Ids are non-empty strings without whitespace; `$addMarkID` throws on
  anything else.
- Marked leaves are rendered with the `mark` theme class (`markOverlap` when
  they carry more than one id) and a `data-lexical-mark-ids` attribute with
  their ids.
- The `markIDNodeKeys` output signal maps each id to the keys of the leaves
  that carry it, for example to scroll to a comment with
  `editor.getElementByKey(key)`.
- In the JSON, the id `c1` is stored as `"$": {"mark:c1": true}` on each
  leaf. Editors without the extension keep these keys as they are.
- Text typed at the edge of a marked run does not join it, as with
  `MarkNode`. Text typed inside a run does, including when it is typed next
  to a link inside the run.
- HTML export leaves the ids out by default, like `MarkNode`, so that they do
  not leak into other applications through the clipboard. Set
  `exportIDsToHTML: true` to write the `data-lexical-mark-ids` attribute.
  HTML imported through the [DOM import pipeline](/docs/serialization/dom-import)
  reads the attribute back; the legacy `$generateNodesFromDOM` ignores it.
- `$migrateMarkNodesToMarkState()` converts a `MarkNode` document. Run it
  once per document with a single writer (for example in a headless editor
  before the document is shared), since unwrapping in a live session is the
  same structural change as any `MarkNode` edit.

### Limitations

- The ids live on the text, so they are copied with it: copying commented
  text with the Lexical clipboard format and pasting it elsewhere puts the
  same id in a second place (as with `MarkNode`). Pasting inside a marked
  run marks pasted text only when it lands in a single TextNode; content of
  several nodes keeps its own ids and leaves a gap in the mark (also as with
  `MarkNode`).
- The ids are NodeState of the leaves, so a leaf that is replaced by a new
  node loses them. This happens wherever code re-creates TextNodes instead
  of editing them: syntax highlighting in a code block re-tokenizes the text
  as you type, and node replacement, text entities and similar transforms
  `replace()` a TextNode with a new one. Marks on such text are dropped.
- Concurrent structural changes to the same text, such as a peer wrapping it
  in a link, re-create that text in Yjs and can drop the marks on it.
- Concurrent typing exactly at the edge of a mark follows the order Yjs gives
  the two edits, so whether the remote text ends up inside the mark is not
  decided by the edge rule above (the peers still converge).
- Each id is a separate key in every Yjs text attribute run it covers, so
  short ids keep the document smaller.
