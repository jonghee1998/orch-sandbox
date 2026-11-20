---
name: Orchestrator 계획
about: 스텝 단위 자동 진행 계획 (orch:go 라벨로 시작)
title: "[plan] "
labels: []
---

목표 설명을 자유롭게 적습니다.

```json
{
  "goal": "한 줄 목표",
  "context": "기술 스택, 제약 등 (선택)",
  "max_retries": 2,
  "auto_merge": true,
  "try": "완성 후 사람이 직접 확인해 볼 방법 (선택)",
  "steps": [
    {
      "id": 1,
      "title": "스텝 제목",
      "task": "무엇을 구현하는지",
      "done_when": ["기계가 확인할 수 있는 완료 기준", "npm test 통과"],
      "stop_if": ["사람 판단이 필요한 상황 (선택)"]
    }
  ]
}
```
