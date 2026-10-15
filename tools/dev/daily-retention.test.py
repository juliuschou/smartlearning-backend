import datetime as dt
import importlib.util
from pathlib import Path
import unittest
spec = importlib.util.spec_from_file_location('retention', Path(__file__).with_name('daily-retention.py'))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
NOW = dt.datetime(2026, 10, 15, tzinfo=dt.timezone.utc)


def manifest(index, days):
    return {'run': f'run-{index}', 'snapshotUTC': {'postgres': (NOW-dt.timedelta(days=days)).isoformat(),
            'smartlearning_test': (NOW-dt.timedelta(days=days)).isoformat()}, 'files': {'fixture': {'sha256': 'abc'}}}


class RetentionTests(unittest.TestCase):
    def test_old_generations_expire_but_deletion_always_blocked(self):
        result = r.select([manifest(i, i*40) for i in range(20)], Path('/owned'), NOW)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['deleteCandidates'], [])
        self.assertTrue(any(x['policyDecision'] == 'expire' for x in result['inventory']))
        self.assertTrue(all(x['effectiveDecision'] == 'keep-blocked' for x in result['inventory']))
        self.assertTrue(all(x['path'] == '/owned/'+x['run'] for x in result['inventory']))

    def test_minimum_seven_and_deterministic_order(self):
        records = [manifest(i, 500+i) for i in range(9)]
        a = r.select(records, Path('/owned'), NOW)
        self.assertEqual(a, r.select(list(reversed(records)), Path('/owned'), NOW))
        self.assertEqual(sum('minimum-seven' in x['reasons'] for x in a['inventory']), 7)

    def test_daily_weekly_monthly_union(self):
        result = r.select([manifest(i, i) for i in range(400)], Path('/owned'), NOW)
        self.assertIn('daily-30-days', result['inventory'][30]['reasons'])
        self.assertNotIn('daily-30-days', result['inventory'][31]['reasons'])
        self.assertEqual(sum('monthly-twelve-months' in x['reasons'] for x in result['inventory']), 12)
        self.assertTrue(any('weekly-eight-weeks' in x['reasons'] for x in result['inventory']))

    def test_future_and_naive_times_rejected(self):
        with self.assertRaises(ValueError):
            r.select([manifest(1, -1)], Path('/owned'), NOW)
        m = manifest(1, 1)
        m['snapshotUTC'] = {'postgres': '2026-10-14T00:00:00'}
        with self.assertRaises(ValueError):
            r.select([m], Path('/owned'), NOW)

    def test_mixed_future_snapshot_rejected(self):
        m = manifest(1, 1)
        m['snapshotUTC']['smartlearning_test'] = (NOW+dt.timedelta(days=1)).isoformat()
        with self.assertRaises(ValueError):
            r.select([m], Path('/owned'), NOW)

    def test_cancelled_copy_does_not_authorize_deletion(self):
        result = r.select([manifest(i, 500+i) for i in range(20)], Path('/owned'), NOW)
        self.assertEqual(result['secondCopyPolicy'], 'cancelled')
        self.assertFalse(result['secondCopyRequired'])
        self.assertEqual(result['blockers'], ['daily-restore-baseline-not-verified',
                                             'latest-attempt-not-independently-verified'])
        self.assertEqual(result['deleteCandidates'], [])
        self.assertTrue(all(x['effectiveDecision'] == 'keep-blocked' for x in result['inventory']))

    def test_empty_inventory_blocked(self):
        self.assertEqual(r.select([], Path('/owned'), NOW)['status'], 'BLOCKED')


if __name__ == '__main__':
    unittest.main()
