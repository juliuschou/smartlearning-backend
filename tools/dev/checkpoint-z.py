"""Supplied-observation comparison only; no external provenance or live adapters."""
import json


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


class ObservationVerifier:
    """Inject into Y.verify; every dependency is explicit.

    observe supplies deployment/serialization observations. authenticate must
    independently authenticate their external provenance and continuity through
    lookup. Equality, hashes and fixture True callbacks cannot supply that trust.
    No filesystem, imports, platform or environment discovery occurs here.
    """

    def __init__(self, *, observe, authenticate, validate_manifest, contract_digest, run_id):
        self.observe = observe
        self.authenticate = authenticate
        self.validate_manifest = validate_manifest
        self.contract_digest = contract_digest
        self.run_id = run_id

    def __call__(self, manifest):
        try:
            # Detach both inputs; neither supplier nor authenticator may rewrite
            # the expected manifest or the observations accepted by this call.
            expected_bytes = canonical(manifest)
            expected = json.loads(expected_bytes)
            self.validate_manifest(expected)
            digest = self.contract_digest(expected)
            observed_bytes = canonical(self.observe())
            observed = json.loads(observed_bytes)
            if type(observed) is not dict or set(observed) != {'deployment', 'serialization'}:
                return False
            if canonical(observed['deployment']) != expected_bytes:
                return False
            if canonical(observed['serialization']) != canonical({
                    'contractId': digest, 'runId': self.run_id,
                    'unchangedThroughLookup': True}):
                return False
            if self.authenticate(expected, observed) is not True:
                return False
            # Reject mutation by the injected authenticator, including bool/int
            # substitutions that Python equality would otherwise accept.
            return (canonical(expected) == expected_bytes and
                    canonical(observed) == observed_bytes)
        except BaseException:
            return False
