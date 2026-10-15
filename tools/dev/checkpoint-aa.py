"""Supplied reviewed bindings only; no live adapter or deployment approval."""
import hashlib
import json
import re

SOURCES = {'checkpoint-y.py', 'checkpoint-z.py', 'checkpoint-aa.py',
           'checkpoint-v-discovery-contract.md', 'checkpoint-x-environment-contract.md'}
ADAPTERS = {'observe', 'authenticate', 'lookup', 'loadedSources', 'recorder'}


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def require(value):
    if not value:
        raise ValueError('Blocked')


def hashes(value):
    return (type(value) is dict and bool(value) and
            all(type(k) is str and bool(k) and type(v) is str and
                re.fullmatch('[a-f0-9]{64}', v) for k, v in value.items()))


def binding_digest(binding):
    require(type(binding) is dict and set(binding) == {
        'format', 'yContractId', 'repositorySources', 'adapterSources', 'dependencyClosure'})
    require(binding['format'] == 'sl-aa-binding-v1')
    require(hashes({'contract': binding['yContractId']}))
    require(hashes(binding['repositorySources']) and set(binding['repositorySources']) == SOURCES)
    require(hashes(binding['adapterSources']) and set(binding['adapterSources']) == ADAPTERS)
    require(hashes(binding['dependencyClosure']))
    return hashlib.sha256(canonical(binding)).hexdigest()


class BoundVerifier:
    """Wrap Z for both Y guards using separately supplied reviewed expectations.

    authenticate_binding must independently authenticate this binding, actual
    loaded callables/dependencies and continuity through lookup. Supplied bytes
    and fixture True callbacks cannot establish those facts or human permission.
    """
    def __init__(self, *, binding, digest, loaded, authenticate_binding,
                 observation_verifier, contract_digest):
        self.binding = json.loads(canonical(binding))
        self.digest = digest
        self.loaded = loaded
        self.authenticate_binding = authenticate_binding
        self.observation_verifier = observation_verifier
        self.contract_digest = contract_digest

    def __call__(self, manifest):
        try:
            expected_bytes = canonical(self.binding)
            expected = json.loads(expected_bytes)
            require(binding_digest(expected) == self.digest)
            require(self.contract_digest(manifest) == expected['yContractId'])
            require(all(expected['repositorySources'][k] == v
                        for k, v in manifest['repositorySources'].items()))
            supplied = self.loaded()
            require(type(supplied) is dict and set(supplied) == {
                'repositorySources', 'adapterSources', 'dependencyClosure'})
            for section, values in supplied.items():
                require(type(values) is dict and set(values) == set(expected[section]))
                require(all(type(data) is bytes and hashlib.sha256(data).hexdigest() ==
                            expected[section][name] for name, data in values.items()))
            require(self.authenticate_binding(expected, self.digest) is True)
            require(canonical(expected) == expected_bytes)
            require(canonical(self.binding) == expected_bytes)
            require(self.observation_verifier(manifest) is True)
            require(canonical(self.binding) == expected_bytes)
            require(self.contract_digest(manifest) == expected['yContractId'])
            return True
        except BaseException:
            return False
