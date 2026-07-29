#!/usr/bin/env node
/**
 * finish-the-work.js — Stop hook 早停拦截
 *
 * 灵感来源: <upstream_author>/<upstream_repo> finish-the-work.sh
 * 检测: 最后一条 assistant 消息只是"说要做"但没真动手（没 tool_use）
 * 动作: decision: block 让 agent 继续干活
 * 安全: stop_hook_active 循环锁 + fail-open
 */
// ponytail: 从上游 50 行 bash+python 翻成 ~60 行 node，加了中文模式

const fs = require('fs');

function main() {
  let input = '';
  process.stdin.on('data', c => (input += c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(input || '{}');

      if (data.stop_hook_active === true) return out({});

      const tp = data.transcript_path;
      if (!tp || !fs.existsSync(tp)) return out({});

      const lines = fs.readFileSync(tp, 'utf8').split('\n').filter(Boolean).slice(-30);

      let lastText = '';
      let lastHadTool = false;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          const msg = obj.message || obj;
          if (msg.role !== 'assistant') continue;
          const content = msg.content;
          if (!Array.isArray(content)) continue;
          const texts = content.filter(b => b.type === 'text').map(b => b.text || '');
          const tools = content.filter(b => b.type === 'tool_use');
          if (texts.length || tools.length) {
            lastText = texts.join('\n').trim();
            lastHadTool = tools.length > 0;
            break;
          }
        } catch (_) { continue; }
      }

      if (lastHadTool || !lastText) return out({});

      const tail = lastText.slice(-500);

      const promiseEN = /\b(I'?ll|I will|let me|next,? I|now I'?ll)\b[^.]{0,60}\b(now|next|then|implement|create|write|add|run|fix|save|build|start|proceed)\b/i;
      const promiseCN = /(我来|我先|接下来我?|下一步|然后我?).{0,30}(写|改|加|跑|建|修|实现|创建|部署|提交|推|测试|检查)/;
      const asksUser = /(\?|？|shall i|would you like|do you want|let me know|which option|你(要|想|觉得|选)|要不要|选哪|怎么定)/i;

      if ((promiseEN.test(tail) || promiseCN.test(tail)) && !asksUser.test(tail)) {
        return out({
          decision: 'block',
          reason: '你刚才说要做某件事但没真动手（没有 tool call）。现在做，别光说。做完或者确实需要用户决策时再停。',
        });
      }

      out({});
    } catch (_) {
      out({});
    }
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

main();
