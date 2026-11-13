// The code of the seed library's "solution only" problem: the stub the solver
// starts from and the hidden runner around it, for Python and Java, and two
// solutions. Test cases carry one JSON value per line — here the one
// argument, an array of arrays — and expect one JSON value.
//
// As everywhere in the seed, the code has to build on the judge's toolchains:
// Python 3.8 (hence the import from __future__ for the annotations) and
// OpenJDK 13.

import type { HarnessCode } from '../../api/types';

export const MERGE_K_LISTS_STARTER: Record<string, string> = {
  // No newline at the end: the cursor belongs in the method body.
  python: [
    '# Definition for singly-linked list.',
    '# class ListNode:',
    '#     def __init__(self, val=0, next=None):',
    '#         self.val = val',
    '#         self.next = next',
    'class Solution:',
    '    def mergeKLists(self, lists: list[ListNode | None]) -> ListNode | None:',
    '        ',
  ].join('\n'),
  java: String.raw`/**
 * Definition for singly-linked list.
 * class ListNode {
 *     int val;
 *     ListNode next;
 *     ListNode(int val) { this.val = val; }
 * }
 */
class Solution {
    public ListNode mergeKLists(ListNode[] lists) {
        
    }
}
`,
};

export const MERGE_K_LISTS_HARNESS: Record<string, HarnessCode> = {
  python: {
    prefix: String.raw`from __future__ import annotations

import json
import sys


class ListNode:
    def __init__(self, val=0, next=None):
        self.val = val
        self.next = next


`,
    suffix: String.raw`

def _to_list(values):
    dummy = tail = ListNode()
    for value in values:
        tail.next = ListNode(value)
        tail = tail.next
    return dummy.next


def _to_values(node):
    values = []
    while node is not None:
        values.append(node.val)
        node = node.next
    return values


if __name__ == "__main__":
    _lists = [_to_list(values) for values in json.loads(sys.stdin.readline())]
    print(json.dumps(_to_values(Solution().mergeKLists(_lists)), separators=(",", ":")))
`,
  },
  java: {
    prefix: String.raw`import java.io.*;
import java.util.*;

class ListNode {
    int val;
    ListNode next;

    ListNode(int val) {
        this.val = val;
    }
}

`,
    suffix: String.raw`
public class Main {
    public static void main(String[] args) throws IOException {
        String line = new BufferedReader(new InputStreamReader(System.in)).readLine().trim();
        // The one argument: a JSON array of arrays of integers.
        List<ListNode> lists = new ArrayList<>();
        StringBuilder number = new StringBuilder();
        ListNode head = null, tail = null;
        int depth = 0;
        for (char c : line.toCharArray()) {
            if (c == '[') {
                depth++;
                head = null;
                tail = null;
            } else if (c == ']' || c == ',') {
                if (number.length() > 0) {
                    ListNode node = new ListNode(Integer.parseInt(number.toString()));
                    number.setLength(0);
                    if (head == null) head = node;
                    else tail.next = node;
                    tail = node;
                }
                if (c == ']' && depth-- == 2) lists.add(head);
            } else if (c != ' ') {
                number.append(c);
            }
        }
        ListNode merged = new Solution().mergeKLists(lists.toArray(new ListNode[0]));
        StringBuilder out = new StringBuilder("[");
        for (ListNode node = merged; node != null; node = node.next) {
            if (node != merged) out.append(',');
            out.append(node.val);
        }
        System.out.println(out.append(']'));
    }
}
`,
  },
};

/** The reference solution: the solution part only, like everything saved for this problem. */
export const MERGE_K_LISTS_REFERENCE = String.raw`import heapq


class Solution:
    def mergeKLists(self, lists: list[ListNode | None]) -> ListNode | None:
        heap = [(node.val, i) for i, node in enumerate(lists) if node]
        heapq.heapify(heap)
        dummy = tail = ListNode()
        while heap:
            _, i = heapq.heappop(heap)
            tail.next = lists[i]
            tail = tail.next
            lists[i] = lists[i].next
            if lists[i]:
                heapq.heappush(heap, (lists[i].val, i))
        return dummy.next
`;

export const MERGE_K_LISTS_JAVA = String.raw`class Solution {
    public ListNode mergeKLists(ListNode[] lists) {
        if (lists.length == 0) return null;
        return merge(lists, 0, lists.length - 1);
    }

    private ListNode merge(ListNode[] lists, int lo, int hi) {
        if (lo == hi) return lists[lo];
        int mid = (lo + hi) / 2;
        ListNode a = merge(lists, lo, mid);
        ListNode b = merge(lists, mid + 1, hi);
        ListNode dummy = new ListNode(0), tail = dummy;
        while (a != null && b != null) {
            if (a.val <= b.val) {
                tail.next = a;
                a = a.next;
            } else {
                tail.next = b;
                b = b.next;
            }
            tail = tail.next;
        }
        tail.next = a != null ? a : b;
        return dummy.next;
    }
}
`;
