/* Tests for FileChangesQueue (debounce + max-batch flush logic). */
import { FileChangesQueue } from '../app/file-changes-queue.js';
import { assertEqual, assertDeepEqual, flushLoop, summary } from './harness.js';

export async function runTests() {
    let q, flushed;

    // 1. debounce: a single event flushes after the debounce window
    q = new FileChangesQueue(50, 5);
    flushed = [];
    q.onFlush(events => flushed.push(events));
    q.push('a');
    assertEqual(flushed.length, 0, 'nothing flushed before debounce window');
    await flushLoop(150);
    assertEqual(flushed.length, 1, 'exactly one flush after debounce');
    assertDeepEqual(flushed[0], ['a'], 'flushed event content');
    await flushLoop(100);
    assertEqual(flushed.length, 1, 'no extra flush while idle');

    // 2. maxIncremental: reaching the batch size flushes immediately
    q = new FileChangesQueue(50, 2);
    flushed = [];
    q.onFlush(events => flushed.push(events));
    q.push('a');
    assertEqual(flushed.length, 0, 'first event stays pending');
    q.push('b');
    assertEqual(flushed.length, 1, 'second event triggers immediate flush');
    assertDeepEqual(flushed[0], ['a', 'b'], 'immediate flush carries both events');
    await flushLoop(150);
    assertEqual(flushed.length, 1, 'no late flush after immediate one');

    // 3. remaining events after an immediate flush are debounced normally
    q.push('c');
    assertEqual(flushed.length, 1, 'event after flush stays pending');
    await flushLoop(150);
    assertEqual(flushed.length, 2, 'pending event flushed after debounce');
    assertDeepEqual(flushed[1], ['c'], 'second flush content');

    // 4. destroy() cancels pending flush
    q = new FileChangesQueue(50, 5);
    flushed = [];
    q.onFlush(events => flushed.push(events));
    q.push('x');
    q.destroy();
    await flushLoop(150);
    assertEqual(flushed.length, 0, 'destroy() cancels the pending timer');

    // 5. maxIncremental getter
    q = new FileChangesQueue(200, 2);
    assertEqual(q.maxIncremental, 2, 'maxIncremental getter');

    return summary('FileChangesQueue');
}
