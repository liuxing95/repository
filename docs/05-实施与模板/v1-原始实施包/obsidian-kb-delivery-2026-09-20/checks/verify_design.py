#!/usr/bin/env python3
"""Read-only document checks and in-memory SQL draft checks. Not app tests."""
from pathlib import Path
import hashlib
import json
import re
import sqlite3
import subprocess
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
checks = []

def passed(name: str) -> None:
    checks.append(name)

def rejects(conn: sqlite3.Connection, sql: str, args: tuple, name: str) -> None:
    conn.execute('SAVEPOINT negative_test')
    try:
        conn.execute(sql, args)
    except sqlite3.IntegrityError:
        conn.execute('ROLLBACK TO negative_test')
        conn.execute('RELEASE negative_test')
        passed(name)
    else:
        conn.execute('ROLLBACK TO negative_test')
        conn.execute('RELEASE negative_test')
        raise AssertionError(f'Expected constraint rejection: {name}')

state = sqlite3.connect(':memory:')
state.executescript((ROOT / 'references/001-state.sql').read_text())
index = sqlite3.connect(':memory:')
index.executescript((ROOT / 'references/002-index.sql').read_text())
passed('Both SQLite DDL drafts execute in fresh in-memory databases')
H = [hashlib.sha256(x.encode()).hexdigest() for x in ['source', 'parsed', 'payload', 'before', 'after', 'manifest']]
for i,h in enumerate(H):
    state.execute('INSERT INTO objects VALUES (?,?,?)', (h, i, f'objects/{h}'))
rejects(state, 'INSERT INTO objects VALUES (?,?,?)', ('z'*64,0,'bad-object'), 'Reject invalid object SHA256')
state.execute('INSERT INTO sources VALUES (?,?,?,?,?,?,?,?)', ('s1','file:s1','Source','file','full_text','active','{"allowedModelRouteIds":[]}','2026-09-20'))
state.execute('INSERT INTO source_revisions VALUES (?,?,?,?,?)', ('r1','s1',H[0],'2026-09-20',None))
rejects(state, 'INSERT INTO source_revisions VALUES (?,?,?,?,?)', ('r2','s1',H[0],'2026-09-21',None), 'Reject duplicate original revision for same source')
rejects(state, 'INSERT INTO source_revisions VALUES (?,?,?,?,?)', ('r3','missing',H[0],'2026-09-21',None), 'Reject missing source foreign key')
state.execute('INSERT INTO parse_artifacts VALUES (?,?,?,?,?,?)', ('p1','r1','parser-1',H[1],'utf16','2026-09-20'))
state.execute('INSERT INTO parse_artifacts VALUES (?,?,?,?,?,?)', ('p2','r1','parser-2',H[1],'utf16','2026-09-20'))
passed('Different parser fingerprints can coexist for the same immutable source')
state.execute('INSERT INTO evidence VALUES (?,?,?,?,?,?)', ('e1','p1','b1',0,3,H[0]))
rejects(state, 'INSERT INTO evidence VALUES (?,?,?,?,?,?)', ('e2','p1','b2',3,3,H[0]), 'Reject empty evidence range')
rejects(state, 'INSERT INTO evidence VALUES (?,?,?,?,?,?)', ('e3','p1','b3',-1,3,H[0]), 'Reject negative evidence start')
rejects(state, 'INSERT INTO claims VALUES (?,?,?,?,?)', ('c1','claim','invented','draft','{}'), 'Reject unsupported claim origin')
state.execute('INSERT INTO snapshots VALUES (?,?,?,?)', ('snap0',0,H[5],'2026-09-20'))
# Insert with named columns to avoid assuming ordering in application code.
state.execute('INSERT INTO jobs(id,operation_key,state,stage,payload_hash,updated_at) VALUES (?,?,?,?,?,?)', ('j1','op1','queued','parse',H[2],'2026-09-20'))
state.execute('INSERT INTO changesets VALUES (?,?,?,?,?,?,?)', ('cs1','j1','snap0',H[4],H[2],'policy-1','proposed'))
state.execute('INSERT INTO patches VALUES (?,?,?,?,?,?)', ('cs1',0,'20-Wiki/example.md','update',H[3],H[4]))
rejects(state, 'INSERT INTO patches VALUES (?,?,?,?,?,?)', ('cs1',1,'20-Wiki/bad.md','create',H[3],H[4]), 'Reject create patch with a before hash')
rejects(state, 'INSERT INTO patches VALUES (?,?,?,?,?,?)', ('cs1',2,'20-Wiki/bad2.md','update',None,H[4]), 'Reject update patch without before hash')
rejects(state, 'INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)', ('ap-bad','cs1',H[3],'policy-1','human',100,200,0), 'Reject approval bound to a different proposal digest')
rejects(state, 'INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)', ('ap-exp','cs1',H[4],'policy-1','human',200,100,0), 'Reject inverted approval validity interval')
state.execute('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?)', ('ap1','cs1',H[4],'policy-1','human',100,200,0))
passed('Accept approval matching changeset digest and policy')
state.execute('INSERT INTO writer_sessions VALUES (?,?,?,?,?)', ('w1','instance1',1,1000,1))
rejects(state, 'INSERT INTO writer_sessions VALUES (?,?,?,?,?)', ('w2','instance2',2,1000,1), 'Reject a second active writer session row')
conflict_hash = hashlib.sha256(b'human edit not stored').hexdigest()
state.execute('INSERT INTO file_receipts VALUES (?,?,?,?,?)', ('cs1',0,'grant1',conflict_hash,'conflict'))
passed('Allow a conflict receipt hash without copying private human text into objects')
state.execute('INSERT INTO budget_buckets VALUES (?,?,?,?,?,?,?)', ('budget','job','j1','all',100,0,0))
stmt='UPDATE budget_buckets SET reserved_microusd=reserved_microusd+? WHERE id=? AND spent_microusd+reserved_microusd+?<=limit_microusd'
assert state.execute(stmt,(70,'budget',70)).rowcount==1
assert state.execute(stmt,(70,'budget',70)).rowcount==0
assert state.execute('SELECT reserved_microusd FROM budget_buckets WHERE id=?',('budget',)).fetchone()==(70,)
passed('Conditional budget UPDATE blocks a second over-limit reservation (sequential SQL smoke test)')
assert state.execute('PRAGMA foreign_key_check').fetchall()==[]
assert state.execute('PRAGMA integrity_check').fetchone()==('ok',)
passed('Seeded state DB passes SQLite integrity and foreign-key checks')
index.execute('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)',(1,'snap0','s1','r1','b1',H[1],'source','family1','["e1"]'))
index.execute('INSERT INTO lexical(rowid,title_terms,body_terms) VALUES (?,?,?)',(1,'检索 夹具','权限 重排 知识 MCP'))
for q in ['权限','重排','知识']:
    assert index.execute('SELECT rowid FROM lexical WHERE lexical MATCH ?', ('"'+q+'"',)).fetchall()==[(1,)]
    passed('FTS accepts explicitly pre-tokenized two-character term: '+q)
for symbol in ['C++','Node.js','app.vault.process']:
    index.execute('INSERT INTO exact_symbols VALUES (?,?)',(symbol,1))
    assert index.execute('SELECT document_row_id FROM exact_symbols WHERE symbol=?',(symbol,)).fetchall()==[(1,)]
    passed('Exact-symbol table preserves: '+symbol)

cfg=json.loads((ROOT/'config/service.example.json').read_text())
assert cfg['initialized'] is False and cfg['vaultId'] is None
assert not cfg['model']['enabled'] and not cfg['writes']['enabled']
assert not cfg['writes']['allowSourceImports'] and not cfg['writes']['allowWikiChanges']
assert not cfg['budget']['confirmed'] and cfg['model']['routes']==[]
passed('Config parses and remains uninitialized, model-disabled and write-disabled')

cases=[json.loads(line) for line in (ROOT/'fixtures/synthetic/eval-cases.jsonl').read_text().splitlines() if line]
assert len(cases)==16 and len({c['id'] for c in cases})==len(cases)
for c in cases:
    assert c['synthetic'] is True
    for key in c['sourceKeys']:
        assert (ROOT/'fixtures/synthetic/sources'/key).is_file(), key
passed('16 synthetic JSONL cases have unique IDs and existing fixture sources')

markdown=list(ROOT.rglob('*.md'))
fences=0
relative_links=0
wiki_links=0
for p in markdown:
    text=p.read_text()
    matches=re.findall(r'^\s*```[^\n]*$',text,re.M)
    assert len(matches)%2==0, f'Unbalanced fences: {p}'
    fences+=len(matches)//2
    defs=set(re.findall(r'^\[(S\d+)\]:',text,re.M))
    uses=set(re.findall(r'\[(S\d+)\]',text))
    assert uses<=defs, f'Undefined source refs in {p}: {uses-defs}'
    for target in re.findall(r'\[[^\]\n]*\]\(([^)\n]+)\)',text):
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',target) or target.startswith('#'):
            continue
        target=unquote(target.split('#')[0])
        assert (p.parent/target).exists(), f'Broken relative link {target} in {p}'
        relative_links+=1
    if 'starter-vault' in p.parts:
        for target in re.findall(r'\[\[([^\]]+)\]\]',text):
            target=target.split('|')[0].split('#')[0]
            assert (ROOT/'starter-vault'/(target+'.md')).exists(), f'Broken wiki link {target}'
            wiki_links+=1
passed(f'Markdown: {len(markdown)} files, {fences} balanced fenced blocks, {relative_links} valid local links, {wiki_links} valid wiki links')
plan=(ROOT/'03-开发任务与验收.md').read_text()
for i in range(18):
    assert re.search(r'^#{2,3} E'+f'{i:02}'+r'：',plan,re.M), f'Missing E{i:02}'
passed('Task plan contains E00-E14 plus E15-E17 optional extensions')

tsc=subprocess.run(['tsc','--strict','--noEmit','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext',str(ROOT/'references/contracts.ts')],capture_output=True,text=True,timeout=30)
assert tsc.returncode==0, tsc.stdout+tsc.stderr
passed('TypeScript reference contracts pass strict noEmit typecheck (not app build)')
result={
 'scope':'Design attachments only; no service, plugin, real-model, upstream-SDK or Vault tests',
 'runtime':{'node':subprocess.check_output(['node','--version'],text=True).strip(),'tsc':subprocess.check_output(['tsc','--version'],text=True).strip(),'sqlite':sqlite3.sqlite_version},
 'checkCount':len(checks),'checks':checks,
 'stateTables':len(state.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()),
 'markdownFiles':len(markdown),'syntheticCases':len(cases)
}
print(json.dumps(result,ensure_ascii=False,indent=2))
