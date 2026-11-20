# orch-sandbox

계획 승인 한 번으로 스텝들이 끝까지 자동 진행되는 AI 개발 오케스트레이터의 시험 저장소입니다.

- **Claude**가 구현 (claude-code-action, 구독 OAuth 토큰)
- **Codex**가 독립 검증 (PR 자동 리뷰, `codex-review-state` 마커)
- **GitHub Actions 상태 머신**이 다음 행동을 결정 (`scripts/orch/`)
- **사람**은 계획 승인, 중단 시 판단, 최종 머지만

## 사용법

1. Issue를 만들고 본문에 ```` ```json ```` 계획을 넣습니다 (템플릿: "Orchestrator 계획").
2. `orch:go` 라벨을 붙입니다. 끝입니다.
3. 진행 상황은 그 Issue 본문의 **진행 상황** 체크리스트와 댓글 로그에 쌓입니다.
4. 알림은 두 경우에만 옵니다 (ntfy): 전체 완료(최종 PR 머지 승인 필요), 중단(판단 필요).

| 하고 싶은 것 | 방법 |
| --- | --- |
| 시작 | 계획 Issue에 `orch:go` 라벨 |
| 중단 후 재개 | 원인 해결 후 `orch:go` 라벨 다시 붙이기 |
| 취소 | `orch:cancel` 라벨 또는 Issue 닫기 |
| 완료 | 최종 PR(`orch/run-N` → `main`)을 직접 머지 |

## 흐름

```
orch:go ─▶ Claude 구현 (orch/run-N-step-K) ─▶ PR → orch/run-N
              ▲                                   │
              │ FAIL (최대 max_retries회 수정)      ▼
              └──────────────────────── Codex 리뷰 + CI
                                                  │ PASS
                                                  ▼
                            스텝 PR 자동 머지 → 다음 스텝 … 마지막 스텝
                                                  ▼
                            최종 PR orch/run-N → main (사람이 머지)
```

판정 규칙
- **PASS**: 현재 PR head SHA에 대한 Codex 리뷰가 `completed` + `has_unresolved_findings=false`이고, CI가 실패하지 않음.
- **FAIL**: Codex 미해결 지적이 있거나 CI 실패 → Claude에게 수정 요청 (`max_retries` 기본 2회).
- **중단**: 수정 한도 초과, Claude가 `.orch/BLOCKED.md` 보고, 변경 없음, Codex 리뷰 실패(사용량 한도), 응답 없음(구현 75분 / 검증 120분).

Codex 판정은 `chatgpt-codex-connector[bot]`(id 199175422, type Bot)가 쓴 마커만 믿고, 커밋 SHA가 현재 head와 같아야 합니다. 이전 커밋에 대한 PASS는 무시합니다.

## 구성

| 파일 | 역할 |
| --- | --- |
| `.github/workflows/orchestrator.yml` | 이벤트(라벨, Codex 댓글, CI 완료, 20분 watchdog) → 상태 전이 |
| `.github/workflows/claude-work.yml` | 오케스트레이터만 dispatch. Claude 실행 → 커밋·푸시 → PR/재검증 요청 |
| `.github/workflows/ci.yml` | `npm test` |
| `scripts/orch/core.mjs` | 순수 로직 (계획 검증, 상태 마커, Codex/CI 판정, 프롬프트) |
| `scripts/orch/main.mjs` | GitHub I/O와 상태 전이 |
| `scripts/orch/*.test.mjs` | 단위 테스트 + 가짜 GitHub 상태 머신 테스트 |

상태는 계획 Issue 본문 끝의 `<!-- orch-state:v1 {...} -->` 마커에 저장됩니다. 상태를 쓰는 작업은 `orch-state-<repo>` concurrency 그룹으로 한 번에 하나만 실행됩니다.

## 필요한 설정

| Secret | 용도 |
| --- | --- |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude 구독 실행 (`claude setup-token`) |
| `BOT_PAT` | Fine-grained PAT, 이 저장소만. Contents / Issues / Pull requests: Read and write. 이 토큰으로 만든 PR·푸시라야 CI와 Codex가 반응합니다 |
| `NTFY_TOPIC` (선택) | 완료·중단 폰 알림 |

그 밖에 Codex 설정에서 이 저장소의 Code review를 켜 두어야 합니다.

## 안전장치

- `orch:go` 라벨은 저장소 소유자가 붙이고, 계획 Issue도 소유자가 작성한 경우에만 동작합니다.
- Claude는 push, PR, 워크플로 수정 권한 없이 실행됩니다. `.github/`·`scripts/orch/`를 바꾸면 푸시를 거부합니다.
- 스텝 PR 머지는 판정한 head SHA로 고정합니다. 그 사이 커밋이 추가되면 머지가 거부됩니다.
- `main` 머지와 배포는 하지 않습니다.
