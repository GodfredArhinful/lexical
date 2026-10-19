/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import {
  effect,
  getPeerDependencyFromEditor,
  namedSignals,
  type ReadonlySignal,
  type Signal,
  signal,
} from '@lexical/extension';
import {
  $setRenderContextValue,
  createRenderState,
  defineImportRule,
  DOMImportExtension,
  domOverride,
  DOMRenderExtension,
  sel,
} from '@lexical/html';
import invariant from '@lexical/internal/invariant';
import {
  $getEditor,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $getState,
  $getStateKeys,
  $hasUpdateTag,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setState,
  addClassNamesToElement,
  type BaseSelection,
  COLLABORATION_TAG,
  COMMAND_PRIORITY_CRITICAL,
  COMPOSITION_START_COMMAND,
  configExtension,
  createState,
  defineExtension,
  HISTORIC_TAG,
  isHTMLElement,
  type Klass,
  type LexicalEditor,
  type LexicalExtension,
  type LexicalNode,
  mergeRegister,
  type NodeKey,
  type PointType,
  removeClassNamesFromElement,
  safeCast,
  type StateConfig,
  TextNode,
} from 'lexical';

import {$isMarkNode} from './MarkNode';

/**
 * The prefix of the NodeState keys that {@link MarkStateExtension} stores
 * mark ids under: the id `c1` is stored as `{"mark:c1": true}` in the `$`
 * record of each leaf it covers.
 *
 * @experimental
 */
export const MARK_STATE_KEY_PREFIX = 'mark:';

/**
 * The attribute that {@link MarkStateExtension} renders on the element of each
 * marked leaf in the editor, holding its space separated ids. HTML export
 * writes it when `exportIDsToHTML` is set, and HTML import reads it back.
 *
 * @experimental
 */
export const MARK_STATE_IDS_ATTRIBUTE = 'data-lexical-mark-ids';

/**
 * Configuration for {@link MarkStateExtension}.
 *
 * @experimental
 */
export interface MarkStateConfig {
  /**
   * When `true`, mark ids are not rendered in the editor DOM, the
   * `markIDNodeKeys` output is emptied and no longer maintained, and text
   * typed at the edge of a marked run is no longer kept out of the mark. The
   * ids stay in the document, and the `$` functions keep working.
   */
  disabled: boolean;
  /**
   * When `true`, HTML export (`$generateHtmlFromNodes`, and so copying to the
   * clipboard as `text/html`) writes the `data-lexical-mark-ids` attribute on
   * marked leaves, so that the ids survive an HTML round trip. Default
   * `false`, like MarkNode, which exports no ids: they are often internal
   * thread ids that should not leak into other applications.
   */
  exportIDsToHTML: boolean;
}

/**
 * Output of {@link MarkStateExtension}.
 *
 * @experimental
 */
export interface MarkStateOutput {
  disabled: Signal<boolean>;
  exportIDsToHTML: Signal<boolean>;
  /**
   * Every mark id in the document, mapped to the keys of the leaves that carry
   * it (in no particular order). A new Map is published after each update that
   * changes it. Empty while the extension is disabled.
   */
  markIDNodeKeys: ReadonlySignal<ReadonlyMap<string, readonly NodeKey[]>>;
}

interface MarkStateInit {
  markIDNodeKeys: Signal<ReadonlyMap<string, readonly NodeKey[]>>;
}

const MARK_STATE_EXTENSION_NAME = '@lexical/mark/MarkState';

type MarkStateExtensionType = LexicalExtension<
  MarkStateConfig,
  typeof MARK_STATE_EXTENSION_NAME,
  MarkStateOutput,
  MarkStateInit
>;

type MarkIDStateConfig = StateConfig<string, boolean>;

let markIDStateConfigs: undefined | Map<string, MarkIDStateConfig>;

const markIDValueConfig = {
  parse: (value: unknown): boolean => value === true,
  // A removed id is unparsed as null rather than false: JSON export already
  // omits the default, and a collaboration binding that writes every known
  // state entry (Yjs v2 text attributes) then removes the attribute instead
  // of keeping a `false` value around for every id ever removed.
  unparse: (value: boolean): true | null => (value ? true : null),
};

/**
 * One StateConfig per key for the whole module: NodeState rejects (in
 * `__DEV__`) two different StateConfig objects with the same key on a node.
 */
function getMarkIDStateConfig(id: string): MarkIDStateConfig {
  const key = MARK_STATE_KEY_PREFIX + id;
  if (markIDStateConfigs === undefined) {
    markIDStateConfigs = new Map();
  }
  let stateConfig = markIDStateConfigs.get(key);
  if (stateConfig === undefined) {
    stateConfig = createState(key, markIDValueConfig);
    markIDStateConfigs.set(key, stateConfig);
  }
  return stateConfig;
}

/**
 * The nodes that carry mark ids: TextNode (and subclasses), LineBreakNode and
 * inline DecoratorNode. Inline ElementNodes such as links are not marked
 * themselves, their leaves are.
 */
function $isMarkableNode(node: null | undefined | LexicalNode): boolean {
  return (
    $isTextNode(node) ||
    $isLineBreakNode(node) ||
    ($isDecoratorNode(node) && node.isInline())
  );
}

function hasMarkIDKey(keys: readonly string[]): boolean {
  return keys.some(key => key.startsWith(MARK_STATE_KEY_PREFIX));
}

/**
 * Get the mark ids stored on a node by {@link MarkStateExtension}, sorted.
 * Nodes that can not carry ids return an empty array.
 *
 * @param node The node
 * @returns The ids, sorted
 *
 * @experimental
 */
export function $getNodeMarkIDs(node: LexicalNode): string[] {
  const ids: string[] = [];
  for (const key of $getStateKeys(node)) {
    if (key.startsWith(MARK_STATE_KEY_PREFIX)) {
      const id = key.slice(MARK_STATE_KEY_PREFIX.length);
      if ($getState(node, getMarkIDStateConfig(id))) {
        ids.push(id);
      }
    }
  }
  return ids.sort();
}

/**
 * Whether `id` can be used as a mark id: a non-empty string without
 * whitespace, since the ids of a leaf are written space separated in the
 * `data-lexical-mark-ids` attribute.
 */
function isValidMarkID(id: string): boolean {
  return typeof id === 'string' && id !== '' && !/\s/.test(id);
}

function assertValidMarkID(id: string): void {
  invariant(
    isValidMarkID(id),
    'MarkStateExtension: invalid mark id %s, ids must be non-empty strings without whitespace',
    JSON.stringify(id),
  );
}

function $markableNodesInSelection(selection: BaseSelection): LexicalNode[] {
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    return [];
  }
  // extract() splits the TextNodes at the boundaries of a RangeSelection, so
  // only the selected part of them is returned.
  return selection.extract().filter($isMarkableNode);
}

/**
 * Add the mark `id` to every TextNode, LineBreakNode and inline DecoratorNode
 * in `selection`, splitting the TextNodes at its boundaries. Ids already on
 * those nodes are kept, so marks can overlap freely. A collapsed selection
 * marks nothing.
 *
 * Each id is stored as its own NodeState key, so two collaborators adding
 * different ids to the same text both keep their id.
 *
 * @param id The mark id, for example a comment thread id. It must be a
 *   non-empty string without whitespace, otherwise this throws.
 * @param selection The selection to mark
 * @returns The nodes that now carry the id
 *
 * @experimental
 */
export function $addMarkID(
  id: string,
  selection: BaseSelection,
): LexicalNode[] {
  assertValidMarkID(id);
  const stateConfig = getMarkIDStateConfig(id);
  const nodes = $markableNodesInSelection(selection);
  for (const node of nodes) {
    $setState(node, stateConfig, true);
  }
  return nodes;
}

function $collectMarkableNodes(node: LexicalNode, out: LexicalNode[]): void {
  if ($isMarkableNode(node)) {
    out.push(node);
  } else if ($isElementNode(node)) {
    for (const child of node.getChildren()) {
      $collectMarkableNodes(child, out);
    }
  }
}

/**
 * The leaves that may carry `id` without a full document walk: the leaves the
 * `markIDNodeKeys` output had for it at the last commit, plus the leaves
 * changed by the pending update (which include every leaf that got the id,
 * or was split off one, since). `null` when the extension is not installed
 * or is disabled.
 */
function $getMarkIDCandidates(id: string): null | LexicalNode[] {
  const editor = $getEditor();
  const dep = getPeerDependencyFromEditor<MarkStateExtensionType>(
    editor,
    MARK_STATE_EXTENSION_NAME,
  );
  if (!dep || dep.output.disabled.peek()) {
    return null;
  }
  const keys = new Set(dep.output.markIDNodeKeys.peek().get(id));
  // @internal access: the leaves this update made dirty, which the update
  // listener receives as `dirtyLeaves` once it commits
  for (const key of editor._dirtyLeaves) {
    keys.add(key);
  }
  const nodes: LexicalNode[] = [];
  for (const key of keys) {
    const node = $getNodeByKey(key);
    if (node !== null && $isMarkableNode(node) && node.isAttached()) {
      nodes.push(node);
    }
  }
  return nodes;
}

/**
 * Remove the mark `id`. With a `selection` it is removed from the nodes in
 * that selection only (splitting the TextNodes at its boundaries), otherwise
 * from the whole document (found through the `markIDNodeKeys` output, or by
 * walking the document when the extension is not active). Text that no
 * longer differs from its neighbors is merged back by normalization.
 *
 * @param id The mark id
 * @param selection Limit the removal to this selection
 *
 * @experimental
 */
export function $removeMarkID(
  id: string,
  selection?: null | BaseSelection,
): void {
  const stateConfig = getMarkIDStateConfig(id);
  let nodes: LexicalNode[];
  if (selection) {
    nodes = $markableNodesInSelection(selection);
  } else {
    const candidates = $getMarkIDCandidates(id);
    if (candidates !== null) {
      nodes = candidates;
    } else {
      nodes = [];
      $collectMarkableNodes($getRoot(), nodes);
    }
  }
  for (const node of nodes) {
    if ($getState(node, stateConfig)) {
      $setState(node, stateConfig, false);
    }
  }
}

function $getPointMarkIDs(point: PointType): string[] {
  const node = point.getNode();
  if (point.type === 'text') {
    const ids = $getNodeMarkIDs(node);
    if (
      ids.length === 0 &&
      $isTextNode(node) &&
      point.offset === node.getTextContentSize()
    ) {
      // Like $getMarkIDs: a caret right before a marked run is in it
      return $getSiblingMarkIDs($getAdjacentLeaf(node, 'next'));
    }
    return ids;
  }
  if ($isElementNode(node)) {
    for (const child of [
      node.getChildAtIndex(point.offset - 1),
      node.getChildAtIndex(point.offset),
    ]) {
      if ($isMarkableNode(child)) {
        const ids = $getNodeMarkIDs(child!);
        if (ids.length > 0) {
          return ids;
        }
      }
    }
  }
  return [];
}

/**
 * Get the mark ids at a selection, sorted. For a collapsed RangeSelection
 * these are the ids of the leaf holding the caret (or of the next leaf, when
 * the caret is at the end of an unmarked TextNode), like `$getMarkIDs` does
 * for MarkNode. Otherwise, `mode` `'any'` (the default) returns the ids on
 * any selected leaf, and `'all'` the ids shared by every selected leaf. The
 * TextNodes that a RangeSelection only touches at an edge are ignored.
 *
 * @param selection The selection, defaults to the current selection
 * @param mode `'any'` or `'all'`, for a selection that is not collapsed
 * @returns The ids, sorted
 *
 * @experimental
 */
export function $getMarkIDsAtSelection(
  selection: null | BaseSelection = $getSelection(),
  mode: 'any' | 'all' = 'any',
): string[] {
  if (!selection) {
    return [];
  }
  if ($isRangeSelection(selection) && selection.isCollapsed()) {
    return $getPointMarkIDs(selection.anchor);
  }
  let leaves = selection.getNodes().filter($isMarkableNode);
  if ($isRangeSelection(selection)) {
    const [start, end] = selection.isBackward()
      ? [selection.focus, selection.anchor]
      : [selection.anchor, selection.focus];
    leaves = leaves.filter(node => {
      if (!$isTextNode(node)) {
        return true;
      }
      const key = node.getKey();
      const from =
        start.type === 'text' && start.key === key ? start.offset : 0;
      const to =
        end.type === 'text' && end.key === key
          ? end.offset
          : node.getTextContentSize();
      return to > from;
    });
  }
  if (leaves.length === 0) {
    return [];
  }
  const idSets = leaves.map($getNodeMarkIDs);
  const result =
    mode === 'any'
      ? Array.from(new Set(idSets.flat()))
      : idSets.reduce((acc, ids) => acc.filter(id => ids.includes(id)));
  return result.sort();
}

/**
 * Convert a document that uses MarkNode into one that uses
 * {@link MarkStateExtension}: the ids of every MarkNode (including the ids of
 * MarkNodes it is nested in) are added to the leaves inside it, and the
 * MarkNode is unwrapped.
 *
 * Run this once per document with a single writer, for example in a headless
 * editor before the document is shared. In a live collaboration session the
 * unwrap is a structural change, with the same concurrency problems as any
 * MarkNode edit. Like {@link $addMarkID}, it throws on an id that is empty or
 * contains whitespace.
 *
 * @param node The subtree to convert, defaults to the root
 * @returns The number of MarkNodes that were unwrapped
 *
 * @experimental
 */
export function $migrateMarkNodesToMarkState(
  node: LexicalNode = $getRoot(),
): number {
  let count = 0;
  const $visit = (current: LexicalNode, inherited: readonly string[]) => {
    if ($isMarkNode(current)) {
      const ownIDs = current.getIDs();
      ownIDs.forEach(assertValidMarkID);
      const ids = Array.from(new Set([...inherited, ...ownIDs]));
      for (const child of current.getChildren()) {
        $visit(child, ids);
      }
      // Re-read: unwrapping a nested MarkNode replaced it with its children
      for (const child of current.getChildren()) {
        current.insertBefore(child);
      }
      current.remove();
      count++;
    } else if ($isMarkableNode(current)) {
      for (const id of inherited) {
        $setState(current, getMarkIDStateConfig(id), true);
      }
    } else if ($isElementNode(current)) {
      for (const child of current.getChildren()) {
        $visit(child, inherited);
      }
    }
  };
  $visit(node, []);
  return count;
}

const MarkStateRenderDisabled = createRenderState(
  'markStateDisabled',
  () => false,
);

function $decorateMarkIDs(
  node: LexicalNode,
  dom: HTMLElement,
  editor: LexicalEditor,
): void {
  const ids = $getNodeMarkIDs(node);
  // @internal access with precedent (CodeNode, HorizontalRuleExtension): the
  // render overrides receive the editor, not its theme
  const {mark, markOverlap} = editor._config.theme;
  if (ids.length > 0) {
    dom.setAttribute(MARK_STATE_IDS_ATTRIBUTE, ids.join(' '));
    addClassNamesToElement(dom, mark);
  } else {
    dom.removeAttribute(MARK_STATE_IDS_ATTRIBUTE);
    removeClassNamesFromElement(dom, mark);
  }
  if (ids.length > 1) {
    addClassNamesToElement(dom, markOverlap);
  } else {
    removeClassNamesFromElement(dom, markOverlap);
  }
}

function $isMarkableNodeMatch(node: LexicalNode): node is LexicalNode {
  return $isMarkableNode(node);
}

const MarkStateImportRule = defineImportRule({
  $import: (_ctx, el, $next) => {
    const nodes = $next();
    const ids = (el.getAttribute(MARK_STATE_IDS_ATTRIBUTE) || '')
      .split(/\s+/)
      .filter(isValidMarkID);
    if (ids.length > 0) {
      const leaves: LexicalNode[] = [];
      for (const node of nodes) {
        $collectMarkableNodes(node, leaves);
      }
      for (const leaf of leaves) {
        for (const id of ids) {
          $setState(leaf, getMarkIDStateConfig(id), true);
        }
      }
    }
    return nodes;
  },
  match: sel.any().attr(MARK_STATE_IDS_ATTRIBUTE, true),
  name: '@lexical/mark/MarkState/ids',
});

/**
 * TextNode and its registered subclasses: transforms are registered per class.
 */
function getTextNodeKlasses(editor: LexicalEditor): Klass<TextNode>[] {
  const klasses: Klass<TextNode>[] = [];
  // @internal access with precedent (NormalizeInlineElementsExtension)
  for (const {klass} of editor._nodes.values()) {
    if (klass === TextNode || klass.prototype instanceof TextNode) {
      klasses.push(klass as Klass<TextNode>);
    }
  }
  return klasses;
}

/**
 * Maintains the `markIDNodeKeys` output after every update from its dirty
 * leaves (which also covers collaboration updates and parsed editor states),
 * with a sweep for leaves removed together with their parent element, and a
 * full rescan for a `setEditorState` of an unparsed state (such as an undo),
 * which only marks the root dirty. Mutation listeners are not used because
 * they do not run without a root element.
 */
function registerMarkIDNodeKeys(
  editor: LexicalEditor,
  output: Signal<ReadonlyMap<string, readonly NodeKey[]>>,
): () => void {
  const idsByKey = new Map<NodeKey, readonly string[]>();
  const keysById = new Map<string, Set<NodeKey>>();
  let changed = false;
  const setKey = (key: NodeKey, ids: readonly string[]) => {
    const prev = idsByKey.get(key) || [];
    if (prev.length === ids.length && prev.every((id, i) => id === ids[i])) {
      return;
    }
    changed = true;
    for (const id of prev) {
      const keys = keysById.get(id);
      if (keys && !ids.includes(id)) {
        keys.delete(key);
        if (keys.size === 0) {
          keysById.delete(id);
        }
      }
    }
    for (const id of ids) {
      let keys = keysById.get(id);
      if (!keys) {
        keys = new Set();
        keysById.set(id, keys);
      }
      keys.add(key);
    }
    if (ids.length > 0) {
      idsByKey.set(key, ids);
    } else {
      idsByKey.delete(key);
    }
  };
  const $visit = (key: NodeKey) => {
    const node = $getNodeByKey(key);
    setKey(
      key,
      node !== null && $isMarkableNode(node) ? $getNodeMarkIDs(node) : [],
    );
  };
  const $rescan = () => {
    const leaves: LexicalNode[] = [];
    $collectMarkableNodes($getRoot(), leaves);
    const seen = new Set<NodeKey>();
    for (const leaf of leaves) {
      seen.add(leaf.getKey());
      setKey(leaf.getKey(), $getNodeMarkIDs(leaf));
    }
    for (const key of Array.from(idsByKey.keys())) {
      if (!seen.has(key)) {
        setKey(key, []);
      }
    }
  };
  const publish = () => {
    if (changed) {
      changed = false;
      const next = new Map<string, readonly NodeKey[]>();
      for (const [id, keys] of keysById) {
        next.set(id, Array.from(keys));
      }
      output.value = next;
    }
  };
  editor.getEditorState().read($rescan);
  publish();
  return mergeRegister(
    editor.registerUpdateListener(
      ({editorState, dirtyElements, dirtyLeaves}) => {
        editorState.read(() => {
          if (
            dirtyLeaves.size === 0 &&
            dirtyElements.size === 1 &&
            dirtyElements.has('root')
          ) {
            $rescan();
            return;
          }
          for (const key of dirtyLeaves) {
            $visit(key);
          }
          if (dirtyElements.size > 0) {
            for (const key of Array.from(idsByKey.keys())) {
              if ($getNodeByKey(key) === null) {
                setKey(key, []);
              }
            }
          }
        });
        publish();
      },
    ),
    () => {
      output.value = new Map();
    },
  );
}

/**
 * A marked TextNode whose start or end the caret is exactly at.
 */
interface EdgeBase {
  key: NodeKey;
  text: string;
  ids: string;
  edge: 'start' | 'end';
}

/**
 * The marked TextNodes whose start or end a collapsed selection is at, in the
 * active editor state.
 */
function $getCaretEdges(): EdgeBase[] {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return [];
  }
  const {anchor} = selection;
  const candidates: [null | LexicalNode, EdgeBase['edge']][] = [];
  if (anchor.type === 'text') {
    const node = anchor.getNode();
    if (anchor.offset === 0) {
      candidates.push([node, 'start']);
    }
    if (anchor.offset === node.getTextContentSize()) {
      candidates.push([node, 'end']);
    }
  } else {
    const parent = anchor.getNode();
    if ($isElementNode(parent)) {
      candidates.push(
        [parent.getChildAtIndex(anchor.offset - 1), 'end'],
        [parent.getChildAtIndex(anchor.offset), 'start'],
      );
    }
  }
  const edges: EdgeBase[] = [];
  for (const [node, edge] of candidates) {
    if ($isTextNode(node)) {
      const ids = $getNodeMarkIDs(node);
      const text = node.getTextContent();
      if (ids.length > 0 && text !== '') {
        edges.push({edge, ids: ids.join(' '), key: node.getKey(), text});
      }
    }
  }
  return edges;
}

function $getSiblingMarkIDs(node: null | LexicalNode): string[] {
  return $isMarkableNode(node) ? $getNodeMarkIDs(node!) : [];
}

/**
 * The leaf next to `node` in `direction` within its block, looking through
 * the boundaries of inline elements such as links: the last leaf of a
 * preceding link, or the leaf after the link that `node` ends. An empty
 * inline element is returned as is (it carries no ids).
 */
function $getAdjacentLeaf(
  node: LexicalNode,
  direction: 'previous' | 'next',
): null | LexicalNode {
  let current: LexicalNode = node;
  for (;;) {
    const sibling =
      direction === 'previous'
        ? current.getPreviousSibling()
        : current.getNextSibling();
    if (sibling === null) {
      const parent = current.getParent();
      if ($isElementNode(parent) && parent.isInline()) {
        current = parent;
        continue;
      }
      return null;
    }
    let leaf: LexicalNode = sibling;
    while ($isElementNode(leaf) && leaf.isInline()) {
      const child: null | LexicalNode =
        direction === 'previous' ? leaf.getLastChild() : leaf.getFirstChild();
      if (child === null) {
        break;
      }
      leaf = child;
    }
    return leaf;
  }
}

/**
 * A TextNode created by this update and holding the caret (typed or pasted
 * text that the core put in a new node, for example when it replaces a
 * selection) gets the ids that both of its neighbors have, so text inserted
 * inside a marked run stays in it.
 */
function $inheritSharedMarkIDs(node: TextNode): void {
  const prevIDs = $getSiblingMarkIDs($getAdjacentLeaf(node, 'previous'));
  if (prevIDs.length === 0) {
    return;
  }
  const nextIDs = $getSiblingMarkIDs($getAdjacentLeaf(node, 'next'));
  const ids = $getNodeMarkIDs(node);
  for (const id of prevIDs) {
    if (nextIDs.includes(id) && !ids.includes(id)) {
      $setState(node, getMarkIDStateConfig(id), true);
    }
  }
}

/**
 * Split text inserted at a marked edge off a TextNode that existed before
 * this update, see {@link registerNonInclusiveEdges}.
 */
function $splitOffEdgeText(
  node: TextNode,
  offset: number,
  edges: readonly EdgeBase[],
): void {
  const key = node.getKey();
  const ids = $getNodeMarkIDs(node);
  const text = node.getTextContent();
  for (const base of edges) {
    const inserted = text.length - base.text.length;
    if (base.key !== key || base.ids !== ids.join(' ') || inserted <= 0) {
      continue;
    }
    let target: null | TextNode = null;
    let keep: string[] = [];
    if (
      base.edge === 'end' &&
      offset === text.length &&
      text.startsWith(base.text)
    ) {
      keep = $getSiblingMarkIDs($getAdjacentLeaf(node, 'next'));
      if (ids.some(id => !keep.includes(id))) {
        target = node.splitText(base.text.length)[1];
      }
    } else if (
      base.edge === 'start' &&
      offset === inserted &&
      text.endsWith(base.text)
    ) {
      keep = $getSiblingMarkIDs($getAdjacentLeaf(node, 'previous'));
      if (ids.some(id => !keep.includes(id))) {
        target = node.splitText(inserted)[0];
      }
    }
    if (target !== null) {
      for (const id of ids) {
        if (!keep.includes(id)) {
          $setState(target, getMarkIDStateConfig(id), false);
        }
      }
      target.select(inserted, inserted);
      return;
    }
  }
}

/**
 * Keep text typed at the edge of a marked run out of the marks that end
 * there, like MarkNode does with `canInsertTextBefore/After`. The core has no
 * hook that consults NodeState when it decides where typed text goes, so the
 * text first lands inside the marked TextNode (natively or through
 * `RangeSelection.insertText`) and is split off here.
 *
 * The rule: in a local, non-historic update, a marked TextNode that the caret
 * was exactly at the start (or end) of before the update, and that grew only
 * at that edge with the caret now right after the inserted text, has the
 * inserted text split off. The new node keeps the ids that the neighbor on
 * that side also has (so typing between two runs of the same id stays in it)
 * and drops the others. Text inserted inside a run keeps its ids: in the
 * node it was typed into, or, when the core created a new TextNode for it
 * (replacing a selection, a format change at the caret, a paste), through
 * the ids that both neighbors of that new node share.
 *
 * Transforms do not run on the node being composed, so for composition the
 * caret position is taken when the composition starts, and the node is
 * checked once it ends.
 */
function registerNonInclusiveEdges(editor: LexicalEditor): () => void {
  let compositionEdges: null | EdgeBase[] = null;
  const $transform = (node: TextNode) => {
    if ($hasUpdateTag(COLLABORATION_TAG) || $hasUpdateTag(HISTORIC_TAG)) {
      return;
    }
    const key = node.getKey();
    const selection = $getSelection();
    if (
      !$isRangeSelection(selection) ||
      !selection.isCollapsed() ||
      selection.anchor.type !== 'text' ||
      selection.anchor.key !== key
    ) {
      return;
    }
    const prevEditorState = editor.getEditorState();
    if (prevEditorState.read(() => $getNodeByKey(key) === null)) {
      $inheritSharedMarkIDs(node);
    } else if (hasMarkIDKey($getStateKeys(node))) {
      $splitOffEdgeText(
        node,
        selection.anchor.offset,
        compositionEdges !== null
          ? compositionEdges
          : prevEditorState.read($getCaretEdges),
      );
    }
  };
  return mergeRegister(
    ...getTextNodeKlasses(editor).map(klass =>
      editor.registerNodeTransform(klass, $transform),
    ),
    editor.registerCommand(
      COMPOSITION_START_COMMAND,
      () => {
        compositionEdges = $getCaretEdges();
        return false;
      },
      COMMAND_PRIORITY_CRITICAL,
    ),
    editor.registerUpdateListener(() => {
      // After the update that ends the composition has run its transforms
      if (compositionEdges !== null && !editor.isComposing()) {
        compositionEdges = null;
      }
    }),
    () => {
      compositionEdges = null;
    },
  );
}

/**
 * An experimental alternative to `MarkNode` for comments and other
 * annotations: each mark id is stored as a NodeState key (`mark:<id>`) on
 * the TextNodes, LineBreakNodes and inline DecoratorNodes it covers, instead
 * of wrapping them in a MarkNode.
 *
 * - Marks overlap freely: text covered by two comments is one TextNode with
 *   both ids, not a MarkNode split into sibling wrappers.
 * - With the Yjs v2 collaboration binding, which syncs TextNode NodeState as
 *   one text attribute per key, concurrent edits by two peers (typing inside a
 *   range that the other comments on, both commenting on the same text,
 *   removing a comment while the other types in it) merge without moving or
 *   duplicating text. Races between three or more peers can still extend a
 *   mark until the v2 binding stops re-applying unchanged text attributes,
 *   and a mark racing a paragraph merge stays order dependent (the merge is
 *   a delete and a re-insert). The v1 binding encodes a TextNode split as a
 *   delete and a re-insert, so it does not get this benefit.
 * - Marked leaves are rendered with the `mark` (and, for more than one id,
 *   `markOverlap`) theme classes and a `data-lexical-mark-ids` attribute.
 *   With `exportIDsToHTML`, HTML export writes that attribute too; the
 *   `@lexical/html` import pipeline reads it back.
 * - Text typed at the edge of a marked run does not join it, like MarkNode.
 *
 * Use {@link $addMarkID}, {@link $removeMarkID},
 * {@link $getMarkIDsAtSelection} and {@link $getNodeMarkIDs} to work with
 * the ids, the `markIDNodeKeys` output to find the nodes of an id, and
 * {@link $migrateMarkNodesToMarkState} to convert MarkNode documents.
 *
 * @experimental
 */
export const MarkStateExtension: MarkStateExtensionType = defineExtension<
  MarkStateConfig,
  typeof MARK_STATE_EXTENSION_NAME,
  MarkStateOutput,
  MarkStateInit
>({
  build: (_editor, config, state): MarkStateOutput => ({
    ...namedSignals(config),
    markIDNodeKeys: state.getInitResult().markIDNodeKeys,
  }),
  config: safeCast<MarkStateConfig>({disabled: false, exportIDsToHTML: false}),
  dependencies: [
    configExtension(DOMRenderExtension, {
      overrides: [
        // A guard rather than [TextNode, LineBreakNode, DecoratorNode]: the
        // class form requires every class to be registered, and DecoratorNode
        // is abstract.
        domOverride(
          [$isMarkableNodeMatch],
          {
            $decorateDOM: (node, _prevNode, dom, editor) =>
              $decorateMarkIDs(node, dom, editor),
          },
          {disabledForEditor: ctx => ctx.get(MarkStateRenderDisabled)},
        ),
        domOverride([$isMarkableNodeMatch], {
          $exportDOM: (node, $next, editor) => {
            const output = $next();
            const dep = getPeerDependencyFromEditor<MarkStateExtensionType>(
              editor,
              MARK_STATE_EXTENSION_NAME,
            );
            if (!dep || !dep.output.exportIDsToHTML.peek()) {
              return output;
            }
            const ids = $getNodeMarkIDs(node);
            if (ids.length > 0 && isHTMLElement(output.element)) {
              output.element.setAttribute(
                MARK_STATE_IDS_ATTRIBUTE,
                ids.join(' '),
              );
            }
            return output;
          },
        }),
      ],
    }),
    configExtension(DOMImportExtension, {rules: [MarkStateImportRule]}),
  ],
  init: (): MarkStateInit => ({markIDNodeKeys: signal(new Map())}),
  name: MARK_STATE_EXTENSION_NAME,
  register: (editor, _config, state) => {
    const {disabled} = state.getOutput();
    const {markIDNodeKeys} = state.getInitResult();
    return effect(() => {
      const isDisabled = disabled.value;
      $setRenderContextValue(MarkStateRenderDisabled, isDisabled, editor);
      if (!isDisabled) {
        return mergeRegister(
          registerMarkIDNodeKeys(editor, markIDNodeKeys),
          registerNonInclusiveEdges(editor),
        );
      }
    });
  },
});
