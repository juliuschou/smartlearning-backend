"""Read-only daily-v1 retention inventory. No deletion implementation."""
import datetime as dt


def select(manifests, root, now):
    records = []
    for m in manifests:
        stamps = [dt.datetime.fromisoformat(t) for t in m['snapshotUTC'].values()]
        if not stamps or any(t.tzinfo is None or t > now for t in stamps):
            raise ValueError('Invalid snapshot time')
        stamp = min(stamps).astimezone(dt.timezone.utc)
        records.append((stamp, m))
    records.sort(key=lambda pair: (pair[0], pair[1]['run']), reverse=True)
    reasons = {m['run']: [] for _, m in records}
    weeks, months = set(), set()
    for index, (stamp, m) in enumerate(records):
        why = reasons[m['run']]
        age = (now - stamp).total_seconds() / 86400
        if index < 7:
            why.append('minimum-seven')
        if age <= 30:
            why.append('daily-30-days')
        week = stamp.isocalendar()[:2]
        if age <= 56 and week not in weeks and len(weeks) < 8:
            why.append('weekly-eight-weeks')
            weeks.add(week)
        month = (stamp.year, stamp.month)
        month_age = (now.year - stamp.year) * 12 + now.month - stamp.month
        if month_age < 12 and month not in months:
            why.append('monthly-twelve-months')
            months.add(month)
    # Restore/attempt receipt verification is not implemented: fail closed.
    blockers = ['daily-restore-baseline-not-verified',
                'latest-attempt-not-independently-verified']
    return {'status': 'BLOCKED', 'dryRun': True, 'blockers': blockers,
            'deleteCandidates': [], 'secondCopyPolicy': 'cancelled', 'secondCopyRequired': False, 'policy': 'proposal-30d-8w-12m-min7',
            'inventory': [{'run': m['run'], 'path': str(root / m['run']),
                           'files': m['files'], 'policyDecision': 'keep' if reasons[m['run']] else 'expire',
                           'reasons': reasons[m['run']] or ['outside-policy'],
                           'effectiveDecision': 'keep-blocked'} for _, m in records]}
