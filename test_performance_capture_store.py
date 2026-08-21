import json
import os
import unittest
import uuid

from performance_capture_store import prepend_performance_capture


def entry(name):
    return {
        'format': 'pcw-base-game-performance-capture',
        'version': 1,
        **({'label': name} if name else {}),
        'settingsAtStart': {'starsEnabled': True},
        'performance': {'fps': {'effective': 60}},
    }


class PerformanceCaptureStoreTest(unittest.TestCase):
    def setUp(self):
        self.path = os.path.abspath(f'.test-performance-capture-{uuid.uuid4().hex}.json')

    def tearDown(self):
        for path in (self.path, f'{self.path}.tmp'):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass

    def test_prepends_newest_entry(self):
        self.assertEqual(prepend_performance_capture(self.path, entry('first')), 1)
        self.assertEqual(prepend_performance_capture(self.path, entry('second')), 2)
        with open(self.path, encoding='utf-8') as handle:
            saved = json.load(handle)
        self.assertEqual([item['label'] for item in saved['entries']], ['second', 'first'])

    def test_accepts_an_entry_without_a_label(self):
        self.assertEqual(prepend_performance_capture(self.path, entry(None)), 1)
        with open(self.path, encoding='utf-8') as handle:
            saved = json.load(handle)
        self.assertNotIn('label', saved['entries'][0])

    def test_rejects_invalid_entry(self):
        with self.assertRaisesRegex(ValueError, 'format'):
            prepend_performance_capture(self.path, {'name': 'bad'})


if __name__ == '__main__':
    unittest.main()
