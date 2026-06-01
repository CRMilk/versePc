$content = [System.IO.File]::ReadAllText('e:\Verse Explorer X\VersePC\css\style.css', [System.Text.Encoding]::UTF8)
$startMarker = '/* --- 子代理卡片 (Trae Solo 风格) --- */'
$endMarker = '/* --- 模型选择弹出层 --- */'
$startIdx = $content.IndexOf($startMarker)
$endIdx = $content.IndexOf($endMarker)
Write-Host "Start index: $startIdx"
Write-Host "End index: $endIdx"

$before = $content.Substring(0, $startIdx)
$after = $content.Substring($endIdx)

$newSection = @"
/* --- 子代理卡片 (Trae Solo 风格) --- */
.ai-subagent-card { background:rgba(255,255,255,0.02); border:1px solid rgba(255,255,255,0.06); border-radius:8px; margin:6px 0; max-width:800px; overflow:hidden; animation:subagentSlideIn 0.25s ease; }
@keyframes subagentSlideIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
.ai-subagent-header { display:flex; align-items:center; gap:8px; padding:6px 10px; cursor:pointer; transition:background 0.15s ease; user-select:none; }
.ai-subagent-header:hover { background:rgba(255,255,255,0.04); }
.ai-subagent-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.ai-subagent-name { font-size:12px; font-weight:600; color:var(--ai-text-primary, #cccccc); flex-shrink:0; }
.ai-subagent-status-text { font-size:11px; color:var(--ai-text-muted, #6e6e6e); flex:1; text-align:right; }
.ai-subagent-chevron { color:var(--ai-text-muted, #6e6e6e); transition:transform 0.2s ease; flex-shrink:0; display:flex; align-items:center; justify-content:center; width:14px; height:14px; }
.ai-subagent-chevron svg { width:14px; height:14px; }
.ai-subagent-chevron.open { transform:rotate(90deg); }
.ai-subagent-body { border-top:1px solid rgba(255,255,255,0.05); max-height:600px; overflow-y:auto; scrollbar-width:thin; transition:max-height 0.3s ease; }
.ai-subagent-body:not(.open) { max-height:0; border-top:none; overflow:hidden; }
.ai-subagent-body::-webkit-scrollbar { width:3px; }
.ai-subagent-body::-webkit-scrollbar-track { background:transparent; }
.ai-subagent-body::-webkit-scrollbar-thumb { background:var(--ai-border, #3e3e42); border-radius:2px; }
.ai-subagent-thinking { display:flex; align-items:center; gap:6px; padding:8px 12px; }
.ai-subagent-thinking-dots { display:flex; gap:3px; align-items:center; }
.ai-subagent-thinking-dots span { width:4px; height:4px; border-radius:50%; background:var(--ai-accent, #0078d4); animation:subagentDot 1.4s ease-in-out infinite; }
.ai-subagent-thinking-dots span:nth-child(2) { animation-delay:0.2s; }
.ai-subagent-thinking-dots span:nth-child(3) { animation-delay:0.4s; }
@keyframes subagentDot { 0%,80%,100% { opacity:0.3; transform:translateY(0); } 40% { opacity:1; transform:translateY(-2px); } }
.ai-subagent-tool-line { display:flex; align-items:center; gap:6px; padding:3px 12px; font-size:11px; color:var(--ai-text-muted); transition:opacity 0.2s; }
.ai-subagent-tool-dot { width:5px; height:5px; border-radius:50%; flex-shrink:0; }
.ai-subagent-tool-desc { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.ai-subagent-tool-status { flex-shrink:0; font-size:10px; color:var(--ai-text-muted); }
.ai-subagent-tool-line.done .ai-subagent-tool-status { color:var(--ai-success, #22c55e); }
.ai-subagent-text-block { padding:6px 12px; font-size:12px; line-height:1.5; color:var(--ai-text-secondary); white-space:pre-wrap; word-break:break-word; }
.ai-subagent-result { border-top:1px solid rgba(255,255,255,0.05); padding:8px 12px; }
.ai-subagent-result-markdown { font-size:12px; color:var(--ai-text-secondary); line-height:1.5; }
.ai-subagent-result-markdown p { margin:3px 0; }
.ai-subagent-result-markdown ul, .ai-subagent-result-markdown ol { padding-left:14px; margin:3px 0; }
.ai-subagent-result-markdown li { margin:1px 0; }
.ai-subagent-result-markdown code { font-family:var(--ai-font-mono, monospace); font-size:11px; background:rgba(255,255,255,0.06); padding:1px 4px; border-radius:3px; }
.ai-subagent-result-markdown pre { background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.06); border-radius:6px; padding:6px 8px; margin:4px 0; overflow-x:auto; }
.ai-subagent-result-markdown pre code { background:none; padding:0; }
.ai-subagent-error { margin:6px 12px; padding:6px 8px; border-radius:6px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.15); font-size:11px; color:#fca5a5; }

"@

$newContent = $before + $newSection + $after
[System.IO.File]::WriteAllText('e:\Verse Explorer X\VersePC\css\style.css', $newContent, [System.Text.Encoding]::UTF8)
Write-Host "Replacement done successfully!"
