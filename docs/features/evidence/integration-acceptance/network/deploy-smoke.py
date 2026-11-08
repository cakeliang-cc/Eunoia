"""Exercise the deployed app; approve only this temporary conversation's browser calls."""
import json, os, re, threading, time, uuid, urllib.request, urllib.error
os.umask(0o077)
BASE = os.environ.get('EUNOIA_SMOKE_URL', 'http://127.0.0.1:8788')
html = urllib.request.urlopen(BASE + '/').read().decode()
token = re.search(r'<meta name="eunoia-token" content="([^"]+)"', html).group(1)
headers = {'Content-Type': 'application/json', 'x-eunoia-token': token}
def api(path, data=None, method=None):
    req = urllib.request.Request(BASE + path, data=None if data is None else json.dumps(data).encode(), headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)
conversation = api('/api/conversations', {'title': '隔离部署验收（自动清理）', 'modelId': 'deepseek-flash'})['conversation']['id']
turn = str(uuid.uuid4())
events, errors, approvals = [], [], []
allowed = {'browser_navigate', 'browser_take_screenshot', 'browser_snapshot', 'browser_tabs', 'browser_close'}
def run():
    payload = {'conversationId': conversation, 'turnId': turn, 'requestId': turn, 'message': '这是部署验收。只使用浏览器 MCP，不要使用任何其他工具，不要读取、修改工作区。先 browser_navigate 打开 data:text/html,<html><title>Eunoia isolation smoke</title><body><h1>Container smoke</h1></body></html> ，再 browser_take_screenshot 截图（filename=deploy-proof.png），最后只回复页面标题。'}
    req = urllib.request.Request(BASE + '/api/chat', data=json.dumps(payload).encode(), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=100) as response:
            for raw in response:
                line = raw.decode().strip()
                if line.startswith('data: '):
                    try: events.append(json.loads(line[6:]))
                    except ValueError: pass
    except Exception as exc: errors.append(type(exc).__name__)
worker = threading.Thread(target=run, daemon=True)
try:
    worker.start()
    deadline = time.monotonic() + 90
    while worker.is_alive() and time.monotonic() < deadline:
        records = api('/api/mcp/interactions?conversationId=' + conversation).get('interactions', [])
        for record in records:
            if record.get('status') != 'pending': continue
            tool = record.get('payload', {}).get('tool')
            if record.get('kind') != 'approval' or tool not in allowed: raise RuntimeError('unexpected approval; refusing to expand this smoke scope')
            api('/api/mcp/interactions/' + record['id'] + '/accept', {})
            approvals.append(tool)
        time.sleep(.25)
    if worker.is_alive(): raise RuntimeError('deployed smoke timed out')
    actions = api('/api/mcp/actions?conversationId=' + conversation)
    results = []
    for action in actions.get('actions', []):
        mapped = json.loads(action['resultJson']) if action.get('resultJson') else {}
        results.append({'tool': action.get('toolName'), 'conclusion': action.get('conclusion'), 'result': mapped})
    names = [row['tool'] for row in results if row['conclusion'] == 'succeeded']
    proof = {'conversationId': conversation, 'turnId': turn, 'approvals': approvals, 'events': [e for e in events if e.get('type') == 'tool_result'], 'errors': errors, 'actions': results}
    with open('/private/tmp/eunoia-deployed-browser-smoke.json', 'w') as f: json.dump(proof, f, ensure_ascii=False, indent=2)
    print(json.dumps({'approvals': approvals, 'actions': [{'tool': row['tool'], 'conclusion': row['conclusion']} for row in results], 'errors': errors}, ensure_ascii=False))
    if errors or 'browser_navigate' not in names or 'browser_take_screenshot' not in names: raise RuntimeError('successful deployed browser actions not observed')
    if not any(e.get('type') == 'tool_result' and e.get('ok') and e.get('name','').endswith('browser_take_screenshot') and e.get('images',0) >= 1 for e in events): raise RuntimeError('screenshot did not become a model image block')
finally:
    api('/api/chat/stop', {'turnId': turn})
    worker.join(timeout=3)
    api('/api/conversations/' + conversation, method='DELETE')
