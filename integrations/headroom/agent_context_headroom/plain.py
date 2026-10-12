"""Private stdin probe / legacy adapter; normal requests use the persistent proxy."""
import json
import sys
from .providers import compress_context

if __name__ == '__main__':
    if hasattr(sys.stdin, 'reconfigure'):
        sys.stdin.reconfigure(encoding='utf-8')
        sys.stdout.reconfigure(encoding='utf-8')
    value = json.loads(sys.stdin.read(500001))
    context, query = value['context'], value['query']
    if not isinstance(context, str) or len(context) > 100000 or not isinstance(query, str) or not query.strip():
        raise ValueError('Invalid compression input')
    print(json.dumps(compress_context(context, query)))
