/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {Provider, UserState} from '@lexical/yjs';

import {getExtensionDependencyFromEditor} from '@lexical/extension';
import {
  $addMarkID,
  $getNodeMarkIDs,
  $removeMarkID,
  MarkStateExtension,
} from '@lexical/mark';
import {LexicalCollaboration} from '@lexical/react/LexicalCollaborationContext';
import {CollaborationPluginV2__EXPERIMENTAL} from '@lexical/react/LexicalCollaborationPlugin';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isTextNode,
  $setSelection,
  defineExtension,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
  UNDO_COMMAND,
} from 'lexical';
import * as React from 'react';
import {act} from 'react';
import {createRoot, type Root} from 'react-dom/client';
import {afterEach, describe, expect, test} from 'vitest';
import * as Y from 'yjs';

/**
 * Two editors with the official v2 collaboration plugin, connected by an
 * in-memory network that keeps each sender's updates in order (as a relay
 * server does). Edits are made while offline and then synced, so they are
 * concurrent.
 */
class Network {
  clients: Client[] = [];

  /** Deliver every pending update, in per-sender order, until quiescent */
  flush() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const receiver of this.clients) {
        for (const sender of this.clients) {
          if (sender === receiver || !sender.online || !receiver.online) {
            continue;
          }
          let index = receiver.received.get(sender) || 0;
          while (index < sender.log.length) {
            Y.applyUpdate(receiver.doc, sender.log[index++], this);
            receiver.received.set(sender, index);
            progress = true;
          }
        }
      }
    }
  }
}

class Client implements Provider {
  doc: Y.Doc;
  /** This client's own updates, in order */
  log: Uint8Array[] = [];
  received = new Map<Client, number>();
  online = false;
  editor: LexicalEditor | null = null;
  root: Root | null = null;
  container: HTMLDivElement | null = null;
  listeners = new Map<string, Set<(data: unknown) => void>>();
  awarenessState: UserState | null = null;
  awareness = {
    getLocalState: () => this.awarenessState,
    getStates: () => new Map([[this.doc.clientID, this.awarenessState!]]),
    off() {},
    on() {},
    setLocalState: (state: UserState | null) => {
      this.awarenessState = state;
    },
    setLocalStateField() {},
  };

  constructor(
    readonly network: Network,
    clientID: number,
  ) {
    this.doc = new Y.Doc({gc: false});
    this.doc.clientID = clientID;
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== this.network) {
        this.log.push(update);
      }
    });
  }

  connect() {
    this.online = true;
    this.network.flush();
    this.dispatch('sync', true);
  }

  disconnect() {
    this.online = false;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(type: string, callback: (data: any) => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(callback);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(type: string, callback: (data: any) => void) {
    const set = this.listeners.get(type);
    if (set) {
      set.delete(callback);
    }
  }

  dispatch(type: string, data: unknown) {
    const set = this.listeners.get(type);
    if (set) {
      set.forEach(callback => callback(data));
    }
  }

  start(parent: HTMLElement) {
    const extension = defineExtension({
      $initialEditorState: null,
      dependencies: [RichTextExtension, MarkStateExtension],
      name: '[root]',
      onError: (error: Error) => {
        throw error;
      },
    });
    const container = document.createElement('div');
    parent.appendChild(container);
    this.container = container;
    this.root = createRoot(container);
    const setEditor = (editor: LexicalEditor) => {
      this.editor = editor;
    };
    act(() => {
      this.root!.render(
        <LexicalCollaboration>
          <LexicalExtensionComposer extension={extension}>
            <EditorRef setEditor={setEditor} />
            <CollaborationPluginV2__EXPERIMENTAL
              id="main"
              doc={this.doc}
              provider={this}
              __shouldBootstrapUnsafe={false}
            />
          </LexicalExtensionComposer>
        </LexicalCollaboration>,
      );
    });
  }

  stop() {
    act(() => {
      this.root!.render(null);
    });
    this.container!.remove();
  }

  getEditor(): LexicalEditor {
    return this.editor!;
  }

  async update(fn: () => void) {
    await act(async () => {
      this.getEditor().update(fn, {discrete: true});
    });
  }

  /** Start a new undo step */
  stopCapturing() {
    const undoManager = (
      this.getEditor() as unknown as Record<symbol, Y.UndoManager | undefined>
    )[Symbol.for('@lexical/yjs/UndoManager')];
    if (undoManager) {
      undoManager.stopCapturing();
    }
  }
}

function EditorRef({setEditor}: {setEditor: (editor: LexicalEditor) => void}) {
  const [editor] = useLexicalComposerContext();
  setEditor(editor);
  return null;
}

const P = 'Revenue grew 4% in Q3.';

function $describeNode(node: LexicalNode): string {
  const ids = $getNodeMarkIDs(node);
  const tag = ids.length > 0 ? `[${ids.join(',')}]` : '';
  if ($isTextNode(node)) {
    return JSON.stringify(node.getTextContent()) + tag;
  }
  if ($isElementNode(node)) {
    return `${node.getType()}(${node
      .getChildren()
      .map($describeNode)
      .join(' ')})`;
  }
  return node.getType() + tag;
}

function tree(client: Client): string {
  return client
    .getEditor()
    .read(() => $getRoot().getChildren().map($describeNode).join(' / '));
}

function registry(client: Client): Record<string, string[]> {
  const editor = client.getEditor();
  const {markIDNodeKeys} = getExtensionDependencyFromEditor(
    editor,
    MarkStateExtension,
  ).output;
  return editor.read(() => {
    const result: Record<string, string[]> = {};
    for (const [id, keys] of markIDNodeKeys.value) {
      result[id] = keys
        .map(key => editor.getEditorState()._nodeMap.get(key))
        .map(node => (node ? node.getTextContent() : '<missing>'))
        .sort();
    }
    return result;
  });
}

function $paragraph(): ElementNode {
  return $getRoot().getFirstChildOrThrow<ElementNode>();
}

function $locate(offset: number, preferNext: boolean): [TextNode, number] {
  let acc = 0;
  const texts = $paragraph().getAllTextNodes();
  for (let i = 0; i < texts.length; i++) {
    const size = texts[i].getTextContentSize();
    if (
      offset < acc + size ||
      (offset === acc + size && (!preferNext || i === texts.length - 1))
    ) {
      return [texts[i], offset - acc];
    }
    acc += size;
  }
  throw new Error(`offset ${offset} out of range`);
}

function $select(start: number, end = start) {
  const [startNode, startOffset] = $locate(start, start !== end);
  const [endNode, endOffset] = $locate(end, false);
  const selection = $createRangeSelection();
  selection.anchor.set(startNode.getKey(), startOffset, 'text');
  selection.focus.set(endNode.getKey(), endOffset, 'text');
  $setSelection(selection);
  return selection;
}

function $typeAt(offset: number, text: string) {
  $select(offset).insertText(text);
}

let cleanup: (() => void) | null = null;

afterEach(() => {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
});

/**
 * Both client id orders, since Yjs breaks ties between concurrent inserts by
 * client id.
 */
const CLIENT_ID_ORDERS = [
  [1, 2],
  [2, 1],
] as const;

async function setupPeers(
  ids: readonly number[],
  $init: () => void = () => {},
) {
  const network = new Network();
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const clients = ids.map(id => new Client(network, id));
  network.clients.push(...clients);
  for (const client of clients) {
    client.start(parent);
  }
  const [first] = clients;
  await first.update(() => {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode(P)));
  });
  await first.update($init);
  await act(async () => network.flush());
  for (const client of clients) {
    client.stopCapturing();
  }
  cleanup = () => {
    for (const client of clients) {
      client.stop();
    }
    parent.remove();
  };
  return {
    clients,
    async offline() {
      for (const client of clients) {
        client.online = false;
      }
    },
    async sync() {
      await act(async () => {
        for (const client of clients) {
          client.online = true;
        }
        network.flush();
      });
    },
  };
}

async function setup(
  ids: readonly [number, number],
  $init: () => void = () => {},
) {
  const peers = await setupPeers(ids, $init);
  const [a, b] = peers.clients;
  return {...peers, a, b};
}

function expectAll(
  clients: readonly Client[],
  expected: string,
  expectedRegistry: Record<string, string[]>,
) {
  for (const client of clients) {
    expect(tree(client)).toBe(expected);
    expect(registry(client)).toEqual(expectedRegistry);
  }
}

function expectBoth(
  {a, b}: {a: Client; b: Client},
  expected: string,
  expectedRegistry: Record<string, string[]>,
) {
  expect(tree(a)).toBe(expected);
  expect(tree(b)).toBe(expected);
  expect(registry(a)).toEqual(expectedRegistry);
  expect(registry(b)).toEqual(expectedRegistry);
  expect(a.doc.toJSON()).toEqual(b.doc.toJSON());
}

describe('MarkStateExtension with collaboration v2', () => {
  for (const order of CLIENT_ID_ORDERS) {
    describe(`client ids ${order.join(',')}`, () => {
      test('W1: typing inside a range ‖ a peer marks it', async () => {
        const ctx = await setup(order);
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew by 4%"[c1] " in Q3.")', {
          c1: ['grew by 4%'],
        });
      });

      test('W3: two peers mark the same range', async () => {
        const ctx = await setup(order);
        await ctx.offline();
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.b.update(() => {
          $addMarkID('c2', $select(8, 15));
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew 4%"[c1,c2] " in Q3.")', {
          c1: ['grew 4%'],
          c2: ['grew 4%'],
        });
      });

      test('two peers mark overlapping ranges', async () => {
        const ctx = await setup(order);
        await ctx.offline();
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.b.update(() => {
          $addMarkID('c2', $select(12, 19));
        });
        await ctx.sync();
        expectBoth(
          ctx,
          'paragraph("Revenue " "grew"[c1] " 4%"[c1,c2] " in "[c2] "Q3.")',
          {c1: [' 4%', 'grew'], c2: [' 4%', ' in ']},
        );
      });

      test('typing inside an overlap ‖ a peer adds the second mark', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => {
          $addMarkID('c2', $select(12, 19));
        });
        await ctx.sync();
        expectBoth(
          ctx,
          'paragraph("Revenue " "grew"[c1] " by 4%"[c1,c2] " in "[c2] "Q3.")',
          {c1: [' by 4%', 'grew'], c2: [' by 4%', ' in ']},
        );
      });

      test('W4: undoing a mark after a peer typed inside it', async () => {
        const ctx = await setup(order);
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        ctx.a.stopCapturing();
        await ctx.b.update(() => $typeAt(13, 'by '));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew by 4%"[c1] " in Q3.")', {
          c1: ['grew by 4%'],
        });
        await act(async () => {
          ctx.a.getEditor().dispatchCommand(UNDO_COMMAND, undefined);
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      });

      test('W4: undoing a mark ‖ a peer types inside it', async () => {
        const ctx = await setup(order);
        await ctx.a.update(() => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.sync();
        ctx.a.stopCapturing();
        await ctx.offline();
        await ctx.b.update(() => $typeAt(13, 'by '));
        await act(async () => {
          ctx.a.getEditor().dispatchCommand(UNDO_COMMAND, undefined);
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      });

      test('R1: removing a mark ‖ a peer types inside it', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c0', $select(8, 15));
        });
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => $removeMarkID('c0'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew by 4% in Q3.")', {});
      });

      test('removing one of two marks ‖ a peer types in the overlap', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
          $addMarkID('c2', $select(12, 19));
        });
        await ctx.offline();
        await ctx.a.update(() => $typeAt(13, 'by '));
        await ctx.b.update(() => $removeMarkID('c1'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue grew" " by 4% in "[c2] "Q3.")', {
          c2: [' by 4% in '],
        });
      });

      test('removing a mark ‖ a peer marks the same range', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.offline();
        await ctx.a.update(() => $removeMarkID('c1'));
        await ctx.b.update(() => {
          $addMarkID('c2', $select(8, 15));
        });
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew 4%"[c2] " in Q3.")', {
          c2: ['grew 4%'],
        });
      });

      test('two peers mark overlapping ranges across a line break', async () => {
        const ctx = await setup(order, () => {
          $paragraph()
            .clear()
            .append(
              $createTextNode('ab'),
              $createLineBreakNode(),
              $createTextNode('cd'),
            );
        });
        const $selectAcrossBreak = (start: number, end: number) => {
          const [first, , last] = $paragraph().getChildren() as TextNode[];
          const selection = $createRangeSelection();
          selection.anchor.set(first.getKey(), start, 'text');
          selection.focus.set(last.getKey(), end, 'text');
          return selection;
        };
        await ctx.offline();
        await ctx.a.update(() => {
          $addMarkID('c1', $selectAcrossBreak(1, 1));
        });
        await ctx.b.update(() => {
          $addMarkID('c2', $selectAcrossBreak(0, 2));
        });
        await ctx.sync();
        expectBoth(
          ctx,
          'paragraph("a"[c2] "b"[c1,c2] linebreak[c1,c2] "c"[c1,c2] "d"[c2])',
          {c1: ['\n', 'b', 'c'], c2: ['\n', 'a', 'b', 'c', 'd']},
        );
      });

      test('text typed at the edge of a mark stays out of it', async () => {
        const ctx = await setup(order, () => {
          $addMarkID('c1', $select(8, 15));
        });
        await ctx.b.update(() => {
          $select(15);
        });
        await ctx.b.update(() => $select(15).insertText('!'));
        await ctx.sync();
        expectBoth(ctx, 'paragraph("Revenue " "grew 4%"[c1] "! in Q3.")', {
          c1: ['grew 4%'],
        });
      });
    });
  }
});

/**
 * Known limitations, pinned so that a change in behavior shows up here. All
 * peers converge in these cases, but a mark can spread onto text nobody
 * marked, or be dropped. The two-peer versions of the races above are
 * correct.
 */
describe('MarkStateExtension with collaboration v2: known limitations', () => {
  // Remove c1 ‖ type inside the c1/c2 overlap ‖ an unrelated edit at the start
  // of the paragraph. It goes wrong when the third peer has the lowest id:
  // c2 spreads onto "Q3.". The cause is in the v2 binding: when it syncs a
  // paragraph, `$updateYText` re-applies the attributes of every TextNode in
  // it from the local, possibly stale, view of the document. These cases
  // pass once the v2 stale-attribute fix lands (the binding then writes only
  // the attributes that changed); turn the `test.fails` into `test` then.
  const THREE_PEER_ORDERS: [readonly [number, number, number], boolean][] = [
    [[1, 2, 3], true],
    [[2, 3, 1], false],
    [[3, 2, 1], false],
  ];
  for (const [ids, passes] of THREE_PEER_ORDERS) {
    (passes ? test : test.fails)(
      `three peers: remove ‖ type in the overlap ‖ type elsewhere (client ids ${ids.join(',')})`,
      async () => {
        const ctx = await setupPeers(ids, () => {
          $paragraph()
            .clear()
            .append($createTextNode('Revenue grew by 4% in Q3.'));
          $addMarkID('c1', $select(8, 18));
          $addMarkID('c2', $select(12, 22));
        });
        const [a, b, c] = ctx.clients;
        await ctx.offline();
        await a.update(() => $removeMarkID('c1'));
        await b.update(() => $typeAt(14, 'XX'));
        await c.update(() => $typeAt(0, 'Z'));
        await ctx.sync();
        expectAll(
          ctx.clients,
          'paragraph("ZRevenue grew" " bXXy 4% in "[c2] "Q3.")',
          {c2: [' bXXy 4% in ']},
        );
      },
    );
  }

  // Mark across two paragraphs ‖ Backspace at the start of the second. One
  // order drops c1 from "Second", the other spreads it onto " line.". This
  // stays order dependent with the stale-attribute fix too: v2 syncs the join
  // as a delete and a re-insert of the second paragraph's text, and where the
  // marked part lands relative to the Yjs format boundaries depends on the
  // order of the concurrent edits.
  for (const order of CLIENT_ID_ORDERS) {
    test.fails(
      `mark across two paragraphs ‖ merge them (client ids ${order.join(',')})`,
      async () => {
        const ctx = await setup(order, () => {
          $getRoot().append(
            $createParagraphNode().append($createTextNode('Second line.')),
          );
        });
        await ctx.offline();
        await ctx.a.update(() => {
          const first = $paragraph().getFirstChildOrThrow<TextNode>();
          const second = $getRoot()
            .getLastChildOrThrow<ElementNode>()
            .getFirstChildOrThrow<TextNode>();
          const selection = $createRangeSelection();
          selection.anchor.set(first.getKey(), 16, 'text');
          selection.focus.set(second.getKey(), 6, 'text');
          $addMarkID('c1', selection);
        });
        await ctx.b.update(() => {
          $getRoot()
            .getLastChildOrThrow<ElementNode>()
            .getFirstChildOrThrow<TextNode>()
            .select(0, 0)
            .deleteCharacter(true);
        });
        await ctx.sync();
        expectAll(
          ctx.clients,
          'paragraph("Revenue grew 4% " "in Q3.Second"[c1] " line.")',
          {c1: ['in Q3.Second']},
        );
      },
    );
  }
});
