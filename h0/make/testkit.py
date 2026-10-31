"""Offline Spark for make tests: no test may reach the live brief branch."""
import json


class OfflineTransport:
    """pipe2 transport stand-in: answers every post with a valid seed brief for the prompt."""
    def __init__(self):
        self.bodies = []

    def post(self, body, timeout):
        from . import core
        self.bodies.append(body)
        user = next((m['content'] for m in body['messages'] if m['role'] == 'user'), '')
        text = json.dumps(core._seed_brief(user.split('\n\n')[0]))
        return {'choices': [{'message': {'content': text}, 'finish_reason': 'stop'}],
                'usage': {'prompt_tokens': 1, 'completion_tokens': 1}}


def offline_spark_module(module_globals):
    """setUpModule/tearDownModule pair that patches core._spark_transport offline."""
    from unittest import mock
    from . import core
    patcher = mock.patch.object(core, '_spark_transport', OfflineTransport)
    module_globals['setUpModule'] = patcher.start
    module_globals['tearDownModule'] = patcher.stop
