#!/usr/bin/env bash
#
# GPT 系エージェント定義(.claude/gpt-agents/<name>.md)を読み、
# そのフロントマターの指定に従って Codex CLI(codex exec)を起動する。
#
# 用法:
#   bash tools/codex-agent.sh <agent-name> [-C <workdir>] [--effort <level>] < prompt.txt
#   bash tools/codex-agent.sh --describe <agent-name> [-C <workdir>] [--effort <level>]
#   bash tools/codex-agent.sh --new-prompt <agent-name> ["<parent-directory>"]
#   bash tools/codex-agent.sh --wait <実行 ID>
#   bash tools/codex-agent.sh --header-of <出力ファイル>
#   bash tools/codex-agent.sh --check-copies
#
# 依頼文は標準入力から読む。引数に埋め込むと引用符の扱いで壊れやすいためである。
# 呼び出し側は依頼文ファイルを標準入力へリダイレクトする。
#
# 標準出力(Codex を起動する場合):
#   codex-agent: agent=... model=... effort=... sandbox=... codex_home=... workdir=...   監査行
#   codex-agent: workdir-from=prompt                                                     依頼文の指定を使った場合
#   codex-agent: warning=workdir-mismatch ... / warning=prompt-workdir-ignored ...       指定の不一致または無視
#   codex-agent: prompt-file=<パス> sha256=<64 桁の 16 進>                             通常ファイルから依頼文を読んだ場合
#   codex-agent: run=<実行 ID> pid=<ラッパーの PID> started=<UTC の ISO 8601>            Codex の起動前に出す
#   codex-agent: log=<ログのパス>                                                         Codex の起動前に出す
#   codex-agent: warning=concurrent-writer run=<相手の実行 ID> log=<相手のログのパス>      該当する目印ごとに 1 行(無ければ出さない)
#   codex-agent: warning=child-spawn-failed count=<回数>                                  Codex の終了後、子プロセスの起動失敗の印があれば出す
#   codex-agent: child-spawn-failed evidence: <最初に一致した行>                           上の行に続けて 1 行
#   codex-agent: warning=sandbox-build-failed count=<回数>                                Codex の終了後、MSBuild がエラー文なしで止まった印があれば出す
#   codex-agent: sandbox-build-failed evidence: <起動したコマンドの行>                     上の行に続けて 1 行
#   codex-agent: warning=codex-exit-forced grace=<秒>                                      最終報告後も残った Codex を停止した場合
#   codex-agent: warning=stderr-collection-truncated grace=<秒>                          本体終了後の標準エラーの収集を打ち切った場合
#   <最終報告>(失敗時はログの末尾と根拠の行)
#   codex-agent: result=...
# run= と log= の行を起動前に出すのは、呼び出し側がバックグラウンドへ移ったあとも、
# 実行中にログの場所と止める対象を特定できるようにするためである。
# 実行 ID はログファイル名から拡張子を除いたものである。
# PID は Git Bash では /proc/$$/winpid の Windows の PID、読めない環境では $$ である。
# ラッパーは停止のシグナルを受けて子を止める処理を持たない。
# Claude Code の Bash ツールがバックグラウンドのコマンドを止めても、ラッパーにシグナルが届かないためである。
# Windows で止めるときは、この pid を taskkill /T /F で止めたあと、
# コマンドラインに <実行 ID>.last(-o に渡す最終報告の受け皿)を含む Codex 側のプロセスも止める。
# Git Bash が Git Bash 系のプログラム(npm のシムの sh など)を起動すると Windows 上の親子関係が途切れ、
# ラッパーの pid への taskkill /T だけでは Codex まで届かないためである。手順は docs/gpt-agents.md の「既知の制約」にある。
#
# 実行ログ(~/.claude/codex-agent/logs/<実行 ID>.log):
#   1 行目は run= の行と同じ内容である。標準出力へ warning=concurrent-writer の行を出すときは、続けて同じ行を書く。残った目印を消したときは note=stale-run-marker-removed の行を書く。
#   Codex の標準エラーは実行中から行ごとに追記する。続けて終了後の警告行(出すときだけ)と Codex の標準出力を追記する。
#   最後の行は標準出力へ出すのと同じ result= の行である。ログだけで完了と結果を判定できるようにするためである。
#   Codex の起動前に止まる経路(終了コード 2、3、試験用フック)ではログを作らない。
#
# 報告の写し(~/.claude/codex-agent/logs/<実行 ID>.report):
#   その実行が標準出力へ出したものと同じ内容で、最後の行は result= の行である。result= の行を出した実行だけが残す。
#   完了を待つ入口 --wait <実行 ID> は、これを読んで元の実行の出力と終了コードを返す。
#   --wait の状態と終了コードは用法の表示(usage)にあり、契約は docs/gpt-agents.md の「完了を待つ」にある。
#   --header-of <出力ファイル> は、背景へ移った起動の出力ファイルの先頭に続く codex-agent: の行(監査行、workdir-from=、prompt-file=、run=、log=、警告)だけを出す。
#   ラッパー役の定義はフックで出力ファイルを読めないため、この入口で実行 ID と「進行中」の報告に添える行を取る。
#
# 書き込み担当の目印(<worktree 固有の git ディレクトリ>/codex-agent/runs/<実行 ID>.run):
#   1 つの worktree に同時に書き込む担当は 1 つとする。
#   ファイルを分けても、ビルドの生成物、テストの実行、git の索引は共有されるためである。
#   codex_sandbox が workspace-write の起動だけが、作業ディレクトリの worktree に目印を置き、終了時に消す。
#   中身は run= の行、log= の行、agent= と sandbox= の行の 3 行である。
#   目印を置く前に同じ置き場の他の目印を調べる。
#   相手のログが無いか、ログの最後の行が result= の行なら、終わった実行の目印として消す。
#   それ以外は --wait と同じ照合で、相手のラッパーと Codex 側のプロセスが残っているかを調べる。
#   どちらも残っていなければ、強制終了で残った目印として消し、自分のログにだけ note=stale-run-marker-removed の行を書く。
#   どちらかが残っているか、照合できない場合は、消さずに warning=concurrent-writer の行を出す。
#   照合できないのは、PowerShell が無い場合、run= の行が読めない場合、相手のログに note=no-output-last-message の行がある場合である。
#   警告は観測の補助であり、起動は止めない。
#   照合できない環境では強制終了で残った目印を実行中と区別できないため、止める形にすると、その worktree の委譲が誤って止まりうるためである。
#   作業ディレクトリが git の管理下に無い場合と、目印の読み書きに失敗した場合は、目印を扱わずに起動する。
#   同じ worktree を編集するメインセッションは、このラッパーを通らないため目印に現れない。
#
# 終了コード:
#   0   Codex が正常終了したか、最終報告後の残存プロセスを停止した
#   2   引数、定義ファイルの内容、環境の不備でスクリプトが起動しなかった
#   3   GPT 側が未導入、無効化、または未設定である
#       (codex コマンドが無い、定義ファイルが無い、codex_enabled: false、または codex_model が無いか空)
#       呼び出し側は Claude へフォールバックする
#   75  呼び出し側では直せない GPT 側の事情で実行できなかった(呼び出し側は Claude へフォールバックする)
#       利用上限なら result=rate-limited、モデルの混雑など他の事情なら result=unavailable
#   他  Codex の終了コードをそのまま返す
#       ただし Codex 自身が 75 で終了した場合は 75 の意味と衝突するため 1 に写像し、
#       元の値は codex-agent: result=failed exit=75 の行に残す

set -u
set -o pipefail

# 本体を main 関数に包み、末尾で 1 回だけ呼ぶ。
# bash はスクリプトを読みながら実行するため、Codex がこのファイル自身を書き換える依頼を
# 処理すると、実行中の bash が書き換え後の内容を途中から読んで構文エラーになる。
# 関数に包むと呼び出し前に全体を読み終えるので、実行中の書き換えに影響されない。
main() {

# このパスは照合の正本を特定するため、カレントディレクトリに依存しない絶対パスにする。
script_path="${BASH_SOURCE[0]}"
script_path="${script_path//\\//}"
case "$script_path" in
  /*|[[:alpha:]]:/*) ;;
  *) script_path="$PWD/$script_path" ;;
esac
script_dir="${script_path%/*}"
checkout_dir="${script_dir%/*}"
[ -n "$checkout_dir" ] || checkout_dir="/"

usage() {
  cat <<'USAGE'
用法: bash tools/codex-agent.sh <agent-name> [-C <workdir>] [--effort <level>] < prompt.txt
      bash tools/codex-agent.sh --describe <agent-name> [-C <workdir>] [--effort <level>]
      bash tools/codex-agent.sh --new-prompt <agent-name> ["<親ディレクトリ>"]
      bash tools/codex-agent.sh --wait <実行 ID>
      bash tools/codex-agent.sh --header-of <出力ファイル>
      bash tools/codex-agent.sh --check-copies

  <agent-name>      .claude/gpt-agents/<agent-name>.md の名前
  -C <workdir>      Codex の作業ディレクトリ(既定はカレントディレクトリ)
                    -C が無いときは依頼文の作業ディレクトリ指定も使う
  --effort <level>  推論 effort を定義ファイルの値より優先して指定する
                    (low|medium|high|xhigh|max|ultra)
  --new-prompt <agent-name> ["<親ディレクトリ>"]
                    排他的に作成した依頼文ディレクトリ内の prompt.md のパスを出す
                    親ディレクトリの既定は ~/.claude/codex-agent/prompts
  --wait <実行 ID>  run= の行の実行 ID の完了を最大 570 秒待ち、完了していれば
                    その実行が標準出力に出した内容をそのまま出す
  --header-of <出力ファイル>
                    背景へ移った起動の出力ファイルの先頭に続く codex-agent: の行だけを出す(0)。
                    ファイルが無い、読めない、その中に run= の行が無いときは
                    codex-agent: not-found header-of=<出力ファイル> を出す(2)
  --check-copies    checkout と利用者ホームにあるスクリプトと定義の写しを JSON で照合する。
                    引数を取らず、Codex を起動せず、標準入力とファイルを変更しない

依頼文は標準入力から読む(--describe、--new-prompt、--wait、--header-of と --check-copies では読まない)。

標準出力は、監査行、依頼文から作業ディレクトリを採用した場合の workdir-from= 行または指定に関する warning= 行、通常ファイルから依頼文を読んだ場合の prompt-file= 行、run= の行、log= の行、最終報告、result= の行の順である。
run= の行と log= の行は Codex の起動前に出す。
書き込み可能な定義では、同じ worktree に書き込み可能な別の実行が残っていると、
log= の行の後に codex-agent: warning=concurrent-writer の行を出す(起動は止めない)。
Codex の経過に子プロセスの起動失敗の印があれば、最終報告の前に
codex-agent: warning=child-spawn-failed の行と、最初の根拠の行を出す(result= の値は変えない)。
MSBuild がエラー文を出さずに Checking File Globs の直後で止まった印があれば、続けて
codex-agent: warning=sandbox-build-failed の行と、起動したコマンドの行を出す(同じく result= は変えない)。
最終報告を書いた後も Codex が終了しない場合は、60 秒後に停止して最終報告の前に
codex-agent: warning=codex-exit-forced の行を出し、Codex の終了コードを 0 とみなして判定する。
本体終了後の標準エラー収集も最大 60 秒待ち、終わらなければ収集だけを停止して
codex-agent: warning=stderr-collection-truncated の行を出す(本体の終了コードは変えない)。
両方の猶予は CODEX_AGENT_EXIT_GRACE_SEC で変更できる(0 以上の整数、既定 60)。
実行中の委譲を止める手順は docs/gpt-agents.md の「既知の制約」にある。

終了コード:
  0   Codex が正常終了したか、最終報告後の残存プロセスを停止した
  2   引数、定義ファイルの内容、環境の不備でスクリプトが起動しなかった
  3   GPT 側が未導入、無効化、または未設定である
      (codex コマンドが無い、定義ファイルが無い、codex_enabled: false、または codex_model が無いか空)
  75  呼び出し側では直せない GPT 側の事情で実行できなかった
      (利用上限なら result=rate-limited、モデルの混雑など他の事情なら result=unavailable)
  他  Codex の終了コードをそのまま返す(Codex 自身の 75 は 1 に写像する)

--wait の状態は標準出力の最後の行で判定する(括弧内は終了コードで、判定の補助である):
  codex-agent: result=...                  完了した。元の実行の出力をそのまま出す(元の実行と同じ)
  codex-agent: waiting run=<実行 ID>        上限までに完了しなかった(124)。もう一度 --wait で待つ
  codex-agent: vanished run=<実行 ID>       ラッパーが result= の行を書かずに消えた(1)
  codex-agent: orphaned run=<実行 ID> pids=<PID,...>
                                           ラッパーは消えたが Codex 側のプロセスが残っている(1)
  codex-agent: unverified run=<実行 ID>     ラッパーは消えたが、Codex が残っているかを確かめられない(1)
                                           (--output-last-message の無い版の Codex で起動した実行)
  codex-agent: not-found run=<実行 ID>      実行 ID のログが無い(2)
USAGE
}

die() {
  printf 'codex-agent: %s\n' "$1" >&2
  exit 2
}

# GPT 側が未導入、無効化、または未設定であることを示す。呼び出し側はこの終了コードで Claude へフォールバックする。
die_missing() {
  printf 'codex-agent: %s\n' "$1" >&2
  printf 'codex-agent: result=failed exit=3\n'
  exit 3
}

# effort は Codex が受け付ける値だけを通す。誤った値を渡すと codex 側で失敗するためである。
validate_effort() {
  case "$1" in
    low|medium|high|xhigh|max|ultra) ;;
    *) die "effort の値が不正である: $1 (low|medium|high|xhigh|max|ultra)" ;;
  esac
}

# エージェント名はそのままパスに埋め込むため、定義ディレクトリの外へ出る形を拒む。
validate_agent_name() {
  case "$1" in
    */*|*\\*|.*) die "エージェント名に / \\ と先頭の . は使えない: $1" ;;
  esac
}

home_dir="${USERPROFILE:-$HOME}"

# Windows のパスを Git Bash が扱える形(スラッシュ区切り)に揃える。
to_slash() {
  local p="$1"
  printf '%s' "${p//\\//}"
}

# Codex と Write ツールへ渡すパスをドライブ文字付きの Windows 形式へ揃える。
# Git Bash の /d/... 形式のままだと解決できないためである。cygpath が無い環境では区切り文字の変換だけを行う。
to_windows_path() {
  local p="" converted=""
  p="$(to_slash "$1")" || return 1
  if command -v cygpath >/dev/null 2>&1; then
    converted="$(cygpath -m "$p" 2>/dev/null || printf '%s' "$p")" || return 1
    strip_long_path_prefix "$converted"
  else
    printf '%s' "$p"
  fi
}

expand_prompt_workdir() {
  local path
  path="$(to_slash "$1")"
  case "$path" in
    "~") path="$(to_slash "$home_dir")" ;;
    "~/"*) path="$(to_slash "$home_dir")/${path#\~/}" ;;
  esac
  printf '%s' "$path"
}

parse_prompt_workdir() {
  printf '%s' "$1" | awk '
    function trim(value) {
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      return value
    }
    function emit(value, first, last) {
      value = trim(value)
      if (length(value) >= 2) {
        first = substr(value, 1, 1)
        last = substr(value, length(value), 1)
        if ((first == "`" || first == "\"" || first == sprintf("%c", 39)) && first == last) {
          value = substr(value, 2, length(value) - 2)
        }
      }
      if (value ~ /[<>]/) print "H" value
      else if ((value ~ /^[[:alpha:]]:/ && (substr(value, 3, 1) == "/" || substr(value, 3, 1) == "\\")) || value ~ /^\// || value ~ /^~\//) print "P" value
      else print "I" value
      found = 1
      exit
    }
    {
      sub(/\r$/, "", $0)
      # CommonMark と同じく、3 文字までの字下げを許し、開始と同じ記号で開始以上の長さの行だけが閉じる。
      line = $0
      sub(/^ {0,3}/, "", line)
      if (fence_char != "") {
        n = 0
        while (substr(line, n + 1, 1) == fence_char) n++
        if (n >= fence_len && substr(line, n + 1) ~ /^[[:space:]]*$/) fence_char = ""
        next
      }
      if (match(line, /^(`{3,}|~{3,})/)) {
        fence_char = substr(line, 1, 1)
        fence_len = RLENGTH
        next
      }
      if (pending) {
        value = trim($0)
        if (value != "") emit(value)
        next
      }
      if ($0 ~ /^作業ディレクトリ(:|：)[[:space:]]*/) {
        value = $0
        sub(/^作業ディレクトリ(:|：)[[:space:]]*/, "", value)
        emit(value)
      }
      if ($0 ~ /^#{1,6}[[:space:]]+作業ディレクトリ[[:space:]]*$/) {
        pending = 1
        next
      }
    }
    END { if (!found) print "" }
  '
}

normalize_workdir_for_compare() {
  local path
  path="$(to_windows_path "$1")"
  while [[ "$path" == */ ]]; do path="${path%/}"; done
  printf '%s' "$path"
}

# cygpath は 260 文字を超えるパスに //?/ を付ける。フックはこの形を依頼文の置き場と認めず、
# Write ツールと bash は接頭辞なしでも長いパスを扱えるので、外して返す。
strip_long_path_prefix() {
  local p="$1"
  case "$p" in
    //\?/UNC/*) printf '//%s' "${p#//\?/UNC/}" ;;
    //\?/*) printf '%s' "${p#//\?/}" ;;
    *) printf '%s' "$p" ;;
  esac
}

agent_name=""
workdir=""
workdir_option=""
effort_override=""
wait_mode=0
wait_run_id=""
header_of_mode=0
header_of_file=""
new_prompt_mode=0
new_prompt_parent=""
new_prompt_parent_set=0
describe_mode=0
check_copies_mode=0

has_describe_option() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --describe) return 0 ;;
      -C|--effort|--wait|--header-of)
        shift
        [ "$#" -eq 0 ] || shift
        ;;
      --new-prompt)
        shift
        if [ "$#" -gt 0 ]; then
          case "$1" in -*) ;; *) shift ;; esac
        fi
        if [ "$#" -gt 0 ]; then
          case "$1" in --describe|--check-copies|--wait|--header-of|-C|--effort|--new-prompt|-h|--help) ;; *) shift ;; esac
        fi
        ;;
      *) shift ;;
    esac
  done
  return 1
}

has_check_copies_option() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --check-copies) return 0 ;;
      -C|--effort|--wait|--header-of)
        shift
        [ "$#" -eq 0 ] || shift
        ;;
      --new-prompt)
        shift
        [ "$#" -eq 0 ] || shift
        ;;
      *) shift ;;
    esac
  done
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --describe)
      [ "$describe_mode" -eq 0 ] || die "--describe は 1 回だけ指定できる"
      describe_mode=1
      shift
      ;;
    --check-copies)
      [ "$check_copies_mode" -eq 0 ] || die "--check-copies は 1 回だけ指定できる"
      check_copies_mode=1
      shift
      ;;
    --new-prompt)
      [ $# -ge 2 ] || die "--new-prompt にはエージェント名が必要である"
      case "$2" in
        -*) die "不明なオプションである: $2" ;;
      esac
      [ "$new_prompt_mode" -eq 0 ] && [ -z "$agent_name" ] \
        || die "--new-prompt はほかの入口と併用できない"
      new_prompt_mode=1
      agent_name="$2"
      shift 2
      if [ $# -gt 0 ]; then
        case "$1" in
          --describe|--check-copies|--wait|--header-of|-C|--effort|--new-prompt|-h|--help) ;;
          *) new_prompt_parent="$1"; new_prompt_parent_set=1; shift ;;
        esac
      fi
      ;;
    --wait)
      [ $# -ge 2 ] || die "--wait には実行 ID が必要である"
      wait_mode=1
      wait_run_id="$2"
      shift 2
      ;;
    --header-of)
      [ $# -ge 2 ] || die "--header-of には出力ファイルが必要である"
      header_of_mode=1
      header_of_file="$2"
      shift 2
      ;;
    -C)
      [ $# -ge 2 ] || die "-C には作業ディレクトリが必要である"
      workdir_option="$2"
      shift 2
      ;;
    --effort)
      [ $# -ge 2 ] || die "--effort には値が必要である"
      effort_override="$2"
      shift 2
      ;;
    -h|--help)
      [ "$new_prompt_mode" -eq 0 ] || die "--new-prompt はほかの入口と併用できない"
      if [ "$check_copies_mode" -eq 1 ] || has_check_copies_option "$@"; then
        die "--check-copies は -h、--help と併用できない"
      fi
      if [ "$describe_mode" -eq 1 ] || has_describe_option "$@"; then
        die "--describe は -h、--help と併用できない"
      fi
      usage
      exit 0
      ;;
    -*)
      die "不明なオプションである: $1"
      ;;
    *)
      [ -z "$agent_name" ] || die "エージェント名は 1 つだけ指定する: $1"
      agent_name="$1"
      shift
      ;;
  esac
done

if [ "$check_copies_mode" -eq 1 ]; then
  [ "$new_prompt_mode" -eq 0 ] && [ "$wait_mode" -eq 0 ] && [ "$header_of_mode" -eq 0 ] \
    && [ "$describe_mode" -eq 0 ] && [ -z "$agent_name" ] \
    && [ -z "$workdir_option" ] && [ -z "$effort_override" ] \
    || die "--check-copies はほかの入口や引数と併用できない"
fi

if [ "$new_prompt_mode" -eq 1 ]; then
  [ "$wait_mode" -eq 0 ] && [ "$header_of_mode" -eq 0 ] && [ "$describe_mode" -eq 0 ] \
    && [ -z "$workdir_option" ] && [ -z "$effort_override" ] \
    || die "--new-prompt は --wait、--header-of、-C、--effort、エージェント名の単独指定と併用できない"
  validate_agent_name "$agent_name"
  if [ "$new_prompt_parent_set" -eq 1 ]; then
    prompt_parent="$(to_slash "$new_prompt_parent")"
    [ -d "$prompt_parent" ] || die "依頼文の親ディレクトリが見つからない: $new_prompt_parent"
  else
    prompt_parent="$(to_slash "$home_dir")/.claude/codex-agent/prompts"
    mkdir -p "$prompt_parent" 2>/dev/null || die "依頼文の置き場を作れない: $prompt_parent"
    chmod 700 "$prompt_parent" 2>/dev/null || true
  fi
  prompt_dir="$(mktemp -d "$prompt_parent/codex-agent-$agent_name-$(date +%Y%m%d-%H%M%S)-XXXXXX" 2>/dev/null)" \
    || die "依頼文のディレクトリを作れない: $prompt_parent"
  printf 'codex-agent: prompt-file=%s\n' "$(to_windows_path "$prompt_dir/prompt.md")"
  exit 0
fi

if [ "$header_of_mode" -eq 1 ]; then
  [ "$wait_mode" -eq 0 ] && [ "$describe_mode" -eq 0 ] && [ -z "$agent_name" ] \
    && [ -z "$workdir_option" ] && [ -z "$effort_override" ] \
    || die "--header-of は --wait、エージェント名、-C、--effort と併用できない"
elif [ "$wait_mode" -eq 1 ]; then
  [ "$describe_mode" -eq 0 ] && [ -z "$agent_name" ] \
    && [ -z "$workdir_option" ] && [ -z "$effort_override" ] \
    || die "--wait はエージェント名、-C、--effort と併用できない"
elif [ "$describe_mode" -eq 1 ]; then
  [ -n "$agent_name" ] || { usage >&2; die "エージェント名が指定されていない"; }
elif [ "$check_copies_mode" -eq 1 ]; then
  :
else
  [ -n "$agent_name" ] || { usage >&2; die "エージェント名が指定されていない"; }
fi

# --header-of <出力ファイル> の本体。契約は docs/gpt-agents.md の「完了を待つ」にある。
# 先頭から codex-agent: で始まる行が続く間だけを出し、最初の別の行で止める。
# ラッパー役の定義が、この入口で Codex の報告や任意のファイルの中身を読めないようにするためである。
print_header_of() {
  local file="$1" path="${1//\\//}" header=""
  if [ -f "$path" ] && [ -r "$path" ]; then
    header="$(tr -d '\r' <"$path" 2>/dev/null | awk '!/^codex-agent: / || NR > 50 { exit } { print }')"
  fi
  if ! printf '%s\n' "$header" | grep -q '^codex-agent: run='; then
    printf 'codex-agent: not-found header-of=%s\n' "$file"
    exit 2
  fi
  printf '%s\n' "$header"
  exit 0
}

[ "$header_of_mode" -eq 0 ] || print_header_of "$header_of_file"

if [ "$describe_mode" -eq 0 ] && [ "$check_copies_mode" -eq 0 ]; then
  validate_agent_name "$agent_name"
fi

[ -z "$effort_override" ] || validate_effort "$effort_override"

log_dir="$(to_slash "$home_dir")/.claude/codex-agent/logs"
# --output-last-message の無い版の Codex で起動したことを、ログに残す目印の行。
NO_LAST_MESSAGE_NOTE="codex-agent: note=no-output-last-message"

# result= の行から、その実行のラッパーが返した終了コードを戻す。規則は下の finish の呼び出しと同じである。
exit_code_of_result() {
  local n
  case "$1" in
    "codex-agent: result=ok"|"codex-agent: result=ok "*) printf '0' ;;
    "codex-agent: result=rate-limited"*|"codex-agent: result=unavailable"*) printf '75' ;;
    "codex-agent: result=failed exit="*)
      n="${1#codex-agent: result=failed exit=}"
      n="${n%% *}"
      case "$n" in
        ''|*[!0-9]*) printf '1' ;;
        75) printf '1' ;;
        *) printf '%s' "$n" ;;
      esac
      ;;
    *) printf '1' ;;
  esac
}

# ラッパー本人と Codex 側のプロセスを 1 回の PowerShell で調べ、wrapper=alive|gone の行と codex=<PID> の行を出す。
# 本人の照合は docs/gpt-agents.md「既知の制約」の止める手順 2 と同じ条件である。PID は再利用されるためである。
# PowerShell が無いか失敗したときは何も出さない。実行 ID を環境変数で渡すのは、PowerShell 自身のコマンドラインを一致させないためである。
# 結果は両方の問い合わせが済んでから出す。途中で失敗して wrapper=gone だけが出ると、残った Codex を見落とすためである。
# probe_run_processes <ラッパーの PID> <started=> <実行 ID>
probe_run_processes() {
  local ps
  ps="$(command -v pwsh 2>/dev/null || command -v powershell 2>/dev/null)" || return 0
  [ -n "$ps" ] || return 0
  CXA_WRAPPER_PID="$1" CXA_STARTED="$2" CXA_RUN_ID="$3" "$ps" -NoProfile -NonInteractive -Command '
    $ErrorActionPreference = "Stop"
    $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [int]$env:CXA_WRAPPER_PID)
    $started = ([datetimeoffset]$env:CXA_STARTED).UtcDateTime
    if ($p -and $p.CommandLine -like "*codex-agent.sh*" -and
        [Math]::Abs(($p.CreationDate.ToUniversalTime() - $started).TotalSeconds) -le 60) { $wrapper = "wrapper=alive" } else { $wrapper = "wrapper=gone" }
    $last = $env:CXA_RUN_ID + ".last"
    $codex = @(Get-CimInstance Win32_Process |
      Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($last) } |
      ForEach-Object { "codex=" + $_.ProcessId })
    $wrapper
    $codex
  ' 2>/dev/null | tr -d '\r'
  return 0
}

kill_process_tree() {
  local process_id="$1" process_list="$2" line child_id child_parent child_command
  while IFS= read -r line; do
    read -r child_id child_parent child_command <<<"$line"
    [ "$child_parent" = "$process_id" ] || continue
    case "$child_id" in
      ''|*[!0-9]*) continue ;;
    esac
    kill_process_tree "$child_id" "$process_list"
  done <<<"$process_list"
  kill -9 "$process_id" 2>/dev/null || true
}

stop_codex_run_processes() {
  local process_id process_list
  kill -0 "$codex_pid" 2>/dev/null || return 1
  case "${OSTYPE:-}" in
    msys*|cygwin*|win32*)
      command -v taskkill >/dev/null 2>&1 || return 1
      # MSYS の PID と Windows の PID は異なり、exec 後は対応する Windows の PID も変わりうる。
      process_id="$(cat "/proc/$codex_pid/winpid" 2>/dev/null)"
      case "$process_id" in
        ''|*[!0-9]*) return 1 ;;
      esac
      taskkill //T //F //PID "$process_id" >/dev/null 2>&1
      ;;
    *)
      process_list="$(ps -eo pid=,ppid=,args= 2>/dev/null)" || return 1
      kill_process_tree "$codex_pid" "$process_list"
      ;;
  esac
}

# --wait <実行 ID> の本体。契約は docs/gpt-agents.md の「完了を待つ」にある。
# 呼び出し側は標準出力の最後の行で状態を判定する。終了コードは Codex の値と重なりうるので補助にとどめる。
# wait_for_run <実行 ID>
wait_for_run() {
  local id="$1" report_file log_file limit run_fields wrapper_pid started line state="unknown" pids=""
  case "$id" in
    ''|*/*|*\\*|.*) die "実行 ID に空、/ \\ と先頭の . は使えない: $id" ;;
  esac
  # 上限は Bash ツールの 600 秒の内側に収める。環境変数はテストで短くするためのものである。
  limit="${CODEX_AGENT_WAIT_LIMIT_SECONDS:-570}"
  case "$limit" in
    ''|*[!0-9]*) die "CODEX_AGENT_WAIT_LIMIT_SECONDS は 0 以上の整数で指定する: $limit" ;;
  esac
  report_file="$log_dir/$id.report"
  log_file="$log_dir/$id.log"

  # 完了していれば元の実行の出力を出して終える。
  # ラッパーは報告を改名してからログへ result= の行を書くため、ログが完了を示すなら報告も既にある。
  # 報告が無いのは、報告を書かない版のラッパーの実行か、改名に失敗した場合である。
  finish_if_done() {
    local last
    if [ -f "$report_file" ]; then
      cat "$report_file"
      exit "$(exit_code_of_result "$(tail -n 1 "$report_file" | tr -d '\r')")"
    fi
    last="$(tail -n 1 "$log_file" 2>/dev/null | tr -d '\r')"
    case "$last" in
      "codex-agent: result="*)
        if [ -f "$report_file" ]; then
          cat "$report_file"
          exit "$(exit_code_of_result "$(tail -n 1 "$report_file" | tr -d '\r')")"
        fi
        printf 'codex-agent: 報告ファイルが無いため、ログの result= の行だけを出す: %s\n' "$(to_windows_path "$log_file")"
        printf '%s\n' "$last"
        exit "$(exit_code_of_result "$last")"
        ;;
    esac
  }

  # 進行の目印としてログの最後の行を出す。出力の無い待ちが続くと、呼び出し側が止まったと判断しやすいためである。
  # 行頭に接頭辞を付け、ログの result= や warning= の行と取り違えないようにする。
  print_last_log_line() {
    local last
    last="$(tail -n 1 "$log_file" 2>/dev/null | tr -d '\r')"
    printf 'codex-agent: last-log-line: %s\n' "${last:0:300}"
  }

  finish_if_done
  if [ ! -f "$log_file" ]; then
    printf 'codex-agent: not-found run=%s\n' "$id"
    printf 'codex-agent: 実行 ID のログが見つからない: %s\n' "$(to_windows_path "$log_file")" >&2
    exit 2
  fi

  # 生死の照合は PowerShell の起動に数秒かかるので、待ちの初めに 1 回だけ行う。
  # 照合できないとき(PowerShell が無い、run= の行が無い)は unknown のまま上限まで待つ。
  run_fields="$(sed -n '1s/^codex-agent: run=[^ ]* pid=\([0-9][0-9]*\) started=\([^ ]*\).*$/\1 \2/p' "$log_file" | tr -d '\r')"
  wrapper_pid="${run_fields%% *}"
  started="${run_fields#* }"
  if [ -n "$run_fields" ]; then
    while IFS= read -r line; do
      case "$line" in
        wrapper=alive) state="alive" ;;
        wrapper=gone) state="gone" ;;
        codex=*) pids="${pids:+$pids,}${line#codex=}" ;;
      esac
    done < <(probe_run_processes "$wrapper_pid" "$started" "$id")
  fi

  # Codex の生死では判定しない。Codex が先に落ちても、ラッパーが生きていれば result=failed を書くためである。
  if [ "$state" = "gone" ]; then
    # 照合の直前にラッパーが終わった場合は、完了として扱う。
    finish_if_done
    print_last_log_line
    if [ -n "$pids" ]; then
      printf 'codex-agent: ラッパーは result= の行を書かずに終わったが、コマンドラインに %s.last を含むプロセスが残っている。docs/gpt-agents.md「既知の制約」の止める手順 3 と 4 で止める\n' "$id"
      printf 'codex-agent: orphaned run=%s pids=%s\n' "$id" "$pids"
    elif grep -qxF "$NO_LAST_MESSAGE_NOTE" <(tr -d '\r' <"$log_file"); then
      printf 'codex-agent: この実行の Codex はコマンドラインに %s.last を持たないため、残っているかを確かめられない。docs/gpt-agents.md「既知の制約」の止める手順 3 で、作業ディレクトリから探す\n' "$id"
      printf 'codex-agent: unverified run=%s\n' "$id"
    else
      printf 'codex-agent: vanished run=%s\n' "$id"
    fi
    exit 1
  fi

  while [ "$SECONDS" -lt "$limit" ]; do
    sleep 1
    finish_if_done
  done
  print_last_log_line
  printf 'codex-agent: waiting run=%s\n' "$id"
  exit 124
}

[ "$wait_mode" -eq 0 ] || wait_for_run "$wait_run_id"

# フロントマターの閉じる区切りが無いと役割文を設定として読むため、両方の区切りを確かめる。
read_front_matter() {
  sed 's/\r$//' "$1" | awk '
    NR == 1 { if ($0 != "---") exit 1; next }
    !closed && $0 == "---" { closed = 1; next }
    !closed { print }
    END { if (!closed) exit 1 }
  '
}

# フロントマターから 1 キーの値を取り出し、行末の YAML コメント、前後の空白、引用符を除く。
# コメントと見なすのは「空白 + #」以降だけである。値の内部の # を巻き込まないためである。
fm_get() {
  local raw=""
  raw="$(printf '%s\n' "$1" | awk -v key="$2" 'index($0, key ":") == 1 { print substr($0, length(key) + 2); exit }')" || return 1
  raw="$(printf '%s' "$raw" | sed -e 's/[[:space:]][[:space:]]*#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')" || return 1
  case "$raw" in
    \"*\") raw="${raw#\"}"; raw="${raw%\"}" ;;
    \'*\') raw="${raw#\'}"; raw="${raw%\'}" ;;
  esac
  printf '%s' "$raw"
}

expand_codex_home() {
  local path=""
  path="$(to_slash "$1")" || return 1
  case "$path" in
    "~") path="$home_dir" ;;
    "~/"*) path="$home_dir/${path#\~/}" ;;
  esac
  path="${path//\$USERPROFILE/$home_dir}"
  path="${path//%USERPROFILE%/$home_dir}"
  to_windows_path "$path"
}

normalize_codex_home() {
  local path=""
  path="$(expand_codex_home "$1")" || return 1
  while [[ "$path" == */ ]]; do path="${path%/}"; done
  printf '%s' "${path,,}"
}

read_role_body() {
  sed 's/\r$//' "$1" | awk '
    NR == 1 { if ($0 != "---") exit; state = 1; next }
    state == 1 && $0 == "---" { state = 2; next }
    state == 2 { print }
  ' | sed -e '/./,$!d'
}

resolve_fail() {
  resolve_status=""
  resolve_reason=""
  resolve_message=""
  resolve_path=""
  resolve_launch_exit=""
  resolve_status="$1"
  resolve_reason="$2"
  resolve_message="$3"
  [ "$#" -lt 4 ] || resolve_path="$4"
  case "$resolve_status" in
    disabled) resolve_launch_exit=3 ;;
    invalid|unreadable) resolve_launch_exit=2 ;;
  esac
  return 1
}

# Codex CLI が無くても、定義で GPT 側を止めている理由(codex-disabled、model-unset)はそちらを返す。
# それ以外は、解決の成否によらず codex-not-found を返し、Codex CLI が無いときの判定順を保つ。
load_agent_definition() {
  local load_status=0
  codex_command_missing=0
  load_agent_definition_values || load_status=1
  [ "$codex_command_missing" -eq 1 ] || return "$load_status"
  if [ "$load_status" -eq 1 ]; then
    case "$resolve_reason" in codex-disabled|model-unset) return 1 ;; esac
  fi
  resolve_fail disabled codex-not-found "codex コマンドが PATH に無い (docs/setup.md の導入手順を参照)" "codex"
}

load_agent_definition_values() {
  resolve_status=""
  resolve_reason=""
  resolve_message=""
  resolve_path=""
  resolve_launch_exit=""
  path_root=""
  def_file=""
  repo_def_file=""
  definition_user=""
  definition_project=""
  front_matter=""
  repo_front_matter=""
  codex_home=""
  codex_model=""
  codex_effort=""
  codex_sandbox=""
  codex_enabled=""
  role_body=""
  repo_role_body=""
  model_source=""
  effort_source=""
  project_applied=false
  line=""
  key=""
  repo_value=""
  user_value=""

  case "$agent_name" in
    */*|*\\*|.*)
      resolve_fail invalid bad-agent-name "エージェント名に / \\ と先頭の . は使えない: $agent_name" "$agent_name"
      return 1
      ;;
  esac

  path_root="$(to_slash "$home_dir")"
  def_file="$path_root/.claude/gpt-agents/$agent_name.md"
  repo_def_file="$PWD/.claude/gpt-agents/$agent_name.md"
  [ -f "$def_file" ] && definition_user="$def_file"
  [ -f "$repo_def_file" ] && definition_project="$repo_def_file"
  [ -n "$definition_user" ] || {
    resolve_fail disabled definition-not-found "エージェント定義が見つからない: $agent_name (.claude/gpt-agents/$agent_name.md)" "$def_file"
    return 1
  }

  check_agent_runtime command || codex_command_missing=1
  front_matter="$(read_front_matter "$def_file")" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  [ -n "$front_matter" ] || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }

  codex_home="$(fm_get "$front_matter" codex_home)" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  codex_model="$(fm_get "$front_matter" codex_model)" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  codex_effort="$(fm_get "$front_matter" codex_reasoning_effort)" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  codex_sandbox="$(fm_get "$front_matter" codex_sandbox)" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  codex_enabled="$(fm_get "$front_matter" codex_enabled)" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  if ! grep -q '^codex_enabled:' <<<"$front_matter"; then
    codex_enabled=true
  fi
  [ -n "$codex_model" ] && model_source=user
  [ -n "$codex_effort" ] && effort_source=user
  role_body="$(read_role_body "$def_file")" || {
    resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
    return 1
  }
  if [ -n "$definition_project" ] && ! [ "$repo_def_file" -ef "$def_file" ]; then
    repo_front_matter="$(read_front_matter "$repo_def_file")" || {
      resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
      return 1
    }
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && continue
      [[ "$line" =~ ^([^[:space:]:]+): ]] || {
        resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
        return 1
      }
      key="${BASH_REMATCH[1]}"
      case "$key" in codex_model|codex_reasoning_effort) continue ;; esac
      repo_value="$(fm_get "$line" "$key")" || {
        resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
        return 1
      }
      user_value="$(fm_get "$front_matter" "$key")" || {
        resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
        return 1
      }
      if [ "$key" = codex_enabled ] && { [ "$repo_value" = false ] || [ "$codex_enabled" = false ]; }; then
        codex_enabled=false
        continue
      fi
      case "$key" in
        codex_home)
          repo_value="$(normalize_codex_home "$repo_value")" || {
            resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
            return 1
          }
          user_value="$(normalize_codex_home "$user_value")" || {
            resolve_fail unreadable front-matter-unreadable-user "フロントマターが読めない: $def_file" "$def_file"
            return 1
          }
          ;;
        codex_sandbox) [ -n "$user_value" ] || user_value=read-only ;;
        codex_enabled) user_value="$codex_enabled" ;;
      esac
      if [ "$repo_value" != "$user_value" ]; then
        resolve_fail invalid project-override-rejected "キー $key が利用者側の実効値と一致しない: $repo_def_file (リポジトリ側の定義で変えられるのは codex_model と codex_reasoning_effort だけ)" "$repo_def_file"
        return 1
      fi
    done <<<"$repo_front_matter"
    project_applied=true
    if grep -q '^codex_model:' <<<"$repo_front_matter"; then
      codex_model="$(fm_get "$repo_front_matter" codex_model)" || {
        resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
        return 1
      }
      model_source=""
      [ -n "$codex_model" ] && model_source=project
    fi
    if grep -q '^codex_reasoning_effort:' <<<"$repo_front_matter"; then
      codex_effort="$(fm_get "$repo_front_matter" codex_reasoning_effort)" || {
        resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
        return 1
      }
      effort_source=""
      [ -n "$codex_effort" ] && effort_source=project
    fi
    repo_role_body="$(read_role_body "$repo_def_file")" || {
      resolve_fail unreadable front-matter-unreadable-project "フロントマターが読めない: $repo_def_file" "$repo_def_file"
      return 1
    }
    case "$repo_role_body" in *[![:space:]]*) role_body="$repo_role_body" ;; esac
  fi

  case "$codex_enabled" in
    true) ;;
    false)
      resolve_fail disabled codex-disabled "GPT 側が無効化されている (codex_enabled: false): $def_file" "$def_file"
      return 1
      ;;
    *)
      resolve_fail invalid bad-enabled "codex_enabled の値が不正である: $codex_enabled (true または false)" "$def_file"
      return 1
      ;;
  esac

  [ -n "$codex_home" ] || {
    resolve_fail invalid codex-home-unset "フロントマターに codex_home が無い: $def_file" "$def_file"
    return 1
  }
  [ -n "$codex_model" ] || {
    resolve_fail disabled model-unset "codex_model が未設定である(GPT 側を使わない): $def_file" "$def_file"
    return 1
  }
  if [ -z "$codex_effort" ]; then
    codex_effort=medium
    effort_source=default
  fi
  [ -n "$codex_sandbox" ] || codex_sandbox=read-only

  case "$codex_effort" in
    low|medium|high|xhigh|max|ultra) ;;
    *)
      resolve_fail invalid bad-effort "effort の値が不正である: $codex_effort (low|medium|high|xhigh|max|ultra)" "$def_file"
      return 1
      ;;
  esac
  case "$codex_sandbox" in
    read-only|workspace-write) ;;
    *)
      resolve_fail invalid bad-sandbox "codex_sandbox の値が不正である: $codex_sandbox (read-only または workspace-write)" "$def_file"
      return 1
      ;;
  esac

  if [ -n "$effort_override" ]; then
    codex_effort="$effort_override"
    effort_source=option
  fi
  return 0
}

check_agent_runtime() {
  runtime_phase=""
  expanded_codex_home=""
  normalized_workdir=""
  workdir_candidate=""
  resolve_status=""
  resolve_reason=""
  resolve_message=""
  resolve_path=""
  resolve_launch_exit=""
  runtime_phase="${1:-}"

  if [ "$runtime_phase" = command ]; then
    command -v codex >/dev/null 2>&1 || {
      resolve_fail disabled codex-not-found "codex コマンドが PATH に無い (docs/setup.md の導入手順を参照)" "codex"
      return 1
    }
    return 0
  fi

  expanded_codex_home="$(expand_codex_home "$codex_home")" || {
    resolve_fail invalid codex-home-missing "codex_home が存在しない: $codex_home (docs/setup.md のログイン手順を参照)" "$codex_home"
    return 1
  }
  codex_home="$expanded_codex_home"
  [ -d "$codex_home" ] || {
    resolve_fail invalid codex-home-missing "codex_home が存在しない: $codex_home (docs/setup.md のログイン手順を参照)" "$codex_home"
    return 1
  }

  workdir_candidate="$workdir_option"
  [ -n "$workdir_candidate" ] || workdir_candidate="$PWD"
  normalized_workdir="$(to_windows_path "$workdir_candidate")" || {
    resolve_fail invalid workdir-missing "作業ディレクトリが存在しない: $workdir_candidate" "$workdir_candidate"
    return 1
  }
  workdir="$normalized_workdir"
  [ -d "$workdir" ] || {
    resolve_fail invalid workdir-missing "作業ディレクトリが存在しない: $workdir" "$workdir"
    return 1
  }
  return 0
}

json_escape() {
  json_value=""
  json_bytes=""
  json_byte=""
  json_oct=""
  json_hex=""
  json_char=""
  json_value="$1"
  # 逃がす文字が無い値は od を起動せずに出す。Windows ではプロセスの起動が重く、値ごとの起動が照会の時間の大半を占めるため。
  case "$json_value" in
    *[[:cntrl:]\\\"]*) ;;
    *) printf '%s' "$json_value"; return 0 ;;
  esac
  json_bytes="$(printf '%s' "$json_value" | LC_ALL=C od -An -v -t u1)" || return 1
  for json_byte in $json_bytes; do
    case "$json_byte" in
      92) printf '\\\\' ;;
      34) printf '\\"' ;;
      10) printf '\\n' ;;
      13) printf '\\r' ;;
      9) printf '\\t' ;;
      0|1|2|3|4|5|6|7|8|11|12|14|15|16|17|18|19|20|21|22|23|24|25|26|27|28|29|30|31)
        printf -v json_hex '%02x' "$json_byte"
        printf '\\u00%s' "$json_hex"
        ;;
      *)
        printf -v json_oct '%03o' "$json_byte"
        printf -v json_char '%b' "\\$json_oct"
        printf '%s' "$json_char"
        ;;
    esac
  done
}

json_quote() {
  printf '"'
  json_escape "$1"
  printf '"'
}

json_nullable() {
  if [ -n "$1" ]; then
    json_quote "$1"
  else
    printf 'null'
  fi
}

file_ends_with_lf() {
  local last_byte=""
  [ -s "$1" ] || { printf '0'; return; }
  last_byte="$(tail -c 1 -- "$1" | od -An -t u1 | tr -d '[:space:]')" || return 1
  [ "$last_byte" = 10 ] && printf '1' || printf '0'
}

normalize_copy_stream() {
  LC_ALL=C sed -z 's/\r\n/\n/g'
}

json_escape_content() {
  LC_ALL=C od -An -v -t u1 | LC_ALL=C awk '
    function emit(byte) {
      if (byte == 92) printf "\\\\"
      else if (byte == 34) printf "\\\""
      else if (byte == 9) printf "\\t"
      else if (byte == 10) printf "\\n"
      else if (byte == 13) printf "\\r"
      else if (byte < 32 || byte == 127) printf "\\u%04x", byte
      else printf "%c", byte
    }
    {
      for (i = 1; i <= NF; i++) {
        byte = $i + 0
        if (pending_cr) {
          if (byte == 10) {
            emit(10)
            pending_cr = 0
            continue
          }
          emit(13)
          pending_cr = 0
        }
        if (byte == 13) pending_cr = 1
        else emit(byte)
      }
    }
    END { if (pending_cr) emit(13) }
  '
}

copy_item_requires() {
  local kind="$1" name="$2" stem=""
  copy_requires=()
  case "$kind" in
    gpt-agent)
      copy_requires+=("script:codex-agent.sh")
      ;;
    claude-agent)
      case "$name" in
        impl-hard.md|impl-light.md|impl-standard.md|codex-review.md|codex-subagent.md)
          stem="${name%.md}"
          copy_requires+=("script:codex-agent.sh" "script:codex-agent-hook.js" "gpt-agent:$name")
          case "$stem" in
            impl-hard|impl-light|impl-standard)
              copy_requires+=("claude-agent:$stem-claude.md")
              ;;
          esac
          ;;
      esac
      ;;
  esac
}

copy_item_index() {
  local wanted="$1" i
  for ((i = 0; i < ${#copy_item_ids[@]}; i++)); do
    if [ "${copy_item_ids[$i]}" = "$wanted" ]; then
      printf '%s' "$i"
      return 0
    fi
  done
  printf '%s' -1
}

copy_item_is_required() {
  local wanted="$1" required_id
  for required_id in "${copy_required_ids[@]}"; do
    [ "$required_id" = "$wanted" ] && return 0
  done
  return 1
}

merge_definition_content() {
  local source="$1" copy="$2" kind="$3" source_final_lf="$4"
  local -a files=("$source")
  [ -z "$copy" ] || files+=("$copy")
  LC_ALL=C awk \
    -v source_path="$source" \
    -v copy_path="$copy" \
    -v kind="$kind" \
    -v source_final_lf="$source_final_lf" '
      function key_for_line(line, i) {
        for (i = 1; i <= key_count; i++) {
          if (index(line, key_order[i] ":") == 1) return key_order[i]
        }
        return ""
      }
      BEGIN {
        if (kind == "gpt-agent") {
          key_order[++key_count] = "codex_model"
          key_order[++key_count] = "codex_reasoning_effort"
          key_order[++key_count] = "codex_home"
          key_order[++key_count] = "codex_enabled"
          meaningful["codex_model"] = 1
          meaningful["codex_reasoning_effort"] = 1
        } else {
          key_order[++key_count] = "model"
          key_order[++key_count] = "effort"
        }
      }
      FILENAME == source_path {
        line = $0
        sub(/\r$/, "", line)
        source_lines[++source_count] = $0
        if (source_count == 1 && line == "---") source_in_front_matter = 1
        else if (source_in_front_matter && line == "---") {
          source_in_front_matter = 0
          source_close = source_count
        } else if (source_in_front_matter) {
          key = key_for_line(line)
          if (key != "" && !(key in source_key_line)) {
            source_key_line[key] = source_count
            source_key_at[source_count] = key
          }
        }
        next
      }
      FILENAME == copy_path {
        line = $0
        sub(/\r$/, "", line)
        copy_lines[++copy_count] = $0
        if (copy_count == 1 && line == "---") copy_in_front_matter = 1
        else if (copy_in_front_matter && line == "---") copy_in_front_matter = 0
        else if (copy_in_front_matter) {
          key = key_for_line(line)
          if (key != "" && !(key in copy_key_line)) {
            copy_key_line[key] = copy_count
          }
        }
        next
      }
      END {
        for (i = 1; i <= source_count; i++) {
          key = source_key_at[i]
          if (key != "") {
            if (key in copy_key_line) {
              line = copy_lines[copy_key_line[key]]
              sub(/\r$/, "", line)
              printf "%s\n", line
              continue
            }
            if (meaningful[key]) continue
          }
          if (i == source_close) {
            for (j = 1; j <= key_count; j++) {
              key = key_order[j]
              if ((key in copy_key_line) && !(key in source_key_line)) {
                line = copy_lines[copy_key_line[key]]
                sub(/\r$/, "", line)
                printf "%s\n", line
              }
            }
          }
          line = source_lines[i]
          if (i < source_count || source_final_lf + 0 == 1) sub(/\r$/, "", line)
          if (i == source_count && source_final_lf + 0 == 0) printf "%s", line
          else printf "%s\n", line
        }
      }
    ' "${files[@]}"
}

copy_item_content_stream() {
  local index="$1" source="${copy_item_sources[$1]}" copy="" kind="${copy_item_kinds[$1]}"
  if [ "${copy_item_present[$index]}" -eq 1 ]; then
    copy="${copy_item_targets[$index]}"
  fi
  case "$kind" in
    script)
      normalize_copy_stream <"$source"
      ;;
    *)
      # 写しが無ければ引き継ぐ値も無い。merge を通すと第 1 群のキーが消え、GPT 側を使わない定義になるため。
      if [ -z "$copy" ] || [ "$copy" = "$source" ]; then
        normalize_copy_stream <"$source"
      else
        merge_definition_content "$source" "$copy" "$kind" "${copy_item_final_lf[$index]}"
      fi
      ;;
  esac
}

copy_item_requires_json() {
  local kind="$1" name="$2" i
  copy_item_requires "$kind" "$name"
  printf '['
  for ((i = 0; i < ${#copy_requires[@]}; i++)); do
    [ "$i" -eq 0 ] || printf ','
    json_quote "${copy_requires[$i]}"
  done
  printf ']'
}

# 全項目の正本と写しのパスを to_windows_path と同じ形へ変換し、copy_item_windows_paths に正本、写しの順で入れる。
# cygpath を 1 回だけ起動するため。行数が合わなければ 1 件ずつ変換する。
copy_items_to_windows_paths() {
  local -a raw=() converted=()
  local i p
  raw=("${copy_item_sources[@]}" "${copy_item_targets[@]}")
  raw=("${raw[@]//\\//}")
  if command -v cygpath >/dev/null 2>&1 && [ "${#raw[@]}" -gt 0 ]; then
    mapfile -t converted < <(cygpath -m "${raw[@]}" 2>/dev/null)
  else
    converted=("${raw[@]}")
  fi
  copy_item_windows_paths=()
  if [ "${#converted[@]}" -ne "${#raw[@]}" ]; then
    for ((i = 0; i < ${#raw[@]}; i++)); do
      copy_item_windows_paths+=("$(to_windows_path "${raw[$i]}")")
    done
    return 0
  fi
  for p in "${converted[@]}"; do
    case "$p" in
      //\?/UNC/*) p="//${p#//\?/UNC/}" ;;
      //\?/*) p="${p#//\?/}" ;;
    esac
    copy_item_windows_paths+=("$p")
  done
}

print_check_copies_json() {
  local checkout_path="$1" head="$2" dirty="$3" i item_count="${#copy_item_ids[@]}"
  local -a copy_item_windows_paths=()
  copy_items_to_windows_paths
  printf '{"protocol":1,"scope":"user-home","checkout":'
  json_quote "$(to_windows_path "$checkout_path")"
  printf ',"head":'
  json_nullable "$head"
  printf ',"dirty":%s,"items":[' "$dirty"
  for ((i = 0; i < ${#copy_item_ids[@]}; i++)); do
    [ "$i" -eq 0 ] || printf ','
    printf '{"id":'
    json_quote "${copy_item_ids[$i]}"
    printf ',"kind":'
    json_quote "${copy_item_kinds[$i]}"
    printf ',"name":'
    json_quote "${copy_item_names[$i]}"
    printf ',"source":'
    json_quote "${copy_item_windows_paths[$i]}"
    printf ',"target":'
    json_quote "${copy_item_windows_paths[$((item_count + i))]}"
    printf ',"status":'
    json_quote "${copy_item_statuses[$i]}"
    printf ',"reason":'
    json_nullable "${copy_item_reasons[$i]}"
    printf ',"source_sha256":'
    json_nullable "${copy_item_source_hashes[$i]}"
    printf ',"observed_sha256":'
    json_nullable "${copy_item_observed_hashes[$i]}"
    printf ',"content":'
    case "${copy_item_statuses[$i]}" in
      stale|missing)
        printf '"'
        copy_item_content_stream "$i" | json_escape_content
        printf '"'
        ;;
      *) printf 'null' ;;
    esac
    printf ',"requires":'
    copy_item_requires_json "${copy_item_kinds[$i]}" "${copy_item_names[$i]}"
    printf '}'
  done
  printf '],"order":["script","gpt-agent","claude-agent"],"after":[{"id":"restart-claude-code","when":"claude-agent"},{"id":"review-role-section","when":"any"}]}\n'
}

check_copies() {
  local checkout="$checkout_dir" user_home="$(to_slash "$home_dir")" claude_home="" \
    head="" dirty="null" git_status="" git_status_ok=1 source name target id index required_id \
    source_fm target_fm hash hash_line hash_output hash_index status reason i queue_index source_final_lf target_exists
  local -a copy_item_ids=() copy_item_kinds=() copy_item_names=() copy_item_sources=() \
    copy_item_targets=() copy_item_present=() copy_item_statuses=() \
    copy_item_reasons=() copy_item_source_hashes=() copy_item_observed_hashes=() \
    copy_item_final_lf=() copy_required_ids=() copy_queue=() copy_processed=() copy_requires=() git_paths=() \
    copy_hash_paths=() copy_hash_items=() copy_hash_targets=()
  local LC_ALL=C

  [ -d "$checkout/.claude/agents" ] && [ -d "$checkout/.claude/gpt-agents" ] \
    && [ -f "$checkout/tools/codex-agent.sh" ] && [ -f "$checkout/tools/codex-agent-hook.js" ] \
    || die "--check-copies は checkout の tools/codex-agent.sh から実行してください"

  if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    claude_home="$(to_slash "$CLAUDE_CONFIG_DIR")"
  else
    claude_home="$user_home/.claude"
  fi

  copy_item_add() {
    local kind="$1" item_name="$2" item_source="$3" item_target="$4" present=0
    local item_id="$kind:$item_name"
    if [ -e "$item_target" ] || [ -L "$item_target" ]; then
      present=1
    fi
    copy_item_ids+=("$item_id")
    copy_item_kinds+=("$kind")
    copy_item_names+=("$item_name")
    copy_item_sources+=("$item_source")
    copy_item_targets+=("$item_target")
    copy_item_present+=("$present")
  }

  copy_item_add script codex-agent-hook.js "$checkout/tools/codex-agent-hook.js" \
    "$user_home/.claude/tools/codex-agent-hook.js"
  copy_item_add script codex-agent.sh "$checkout/tools/codex-agent.sh" \
    "$user_home/.claude/tools/codex-agent.sh"

  for source in "$checkout/.claude/gpt-agents/"*.md; do
    [ -f "$source" ] || continue
    name="${source##*/}"
    copy_item_add gpt-agent "$name" "$source" "$user_home/.claude/gpt-agents/$name"
  done
  for source in "$checkout/.claude/agents/"*.md; do
    [ -f "$source" ] || continue
    name="${source##*/}"
    copy_item_add claude-agent "$name" "$source" "$claude_home/agents/$name"
  done

  copy_required_ids=(
    claude-agent:impl-hard.md
    claude-agent:impl-hard-claude.md
    gpt-agent:impl-hard.md
  )
  for ((i = 0; i < ${#copy_item_ids[@]}; i++)); do
    if [ "${copy_item_present[$i]}" -eq 1 ]; then
      copy_queue+=("${copy_item_ids[$i]}")
    fi
  done
  copy_queue+=("${copy_required_ids[@]}")
  queue_index=0
  while [ "$queue_index" -lt "${#copy_queue[@]}" ]; do
    id="${copy_queue[$queue_index]}"
    queue_index=$((queue_index + 1))
    target_exists=0
    for required_id in "${copy_processed[@]}"; do
      if [ "$required_id" = "$id" ]; then target_exists=1; break; fi
    done
    [ "$target_exists" -eq 0 ] || continue
    copy_processed+=("$id")
    if ! copy_item_is_required "$id"; then copy_required_ids+=("$id"); fi
    index="$(copy_item_index "$id")"
    [ "$index" -ge 0 ] || continue
    copy_item_requires "${copy_item_kinds[$index]}" "${copy_item_names[$index]}"
    for required_id in "${copy_requires[@]}"; do
      copy_queue+=("$required_id")
    done
  done

  for ((i = 0; i < ${#copy_item_ids[@]}; i++)); do
    copy_item_source_hashes+=("")
    copy_item_observed_hashes+=("")
    if [ -f "${copy_item_sources[$i]}" ] && [ -r "${copy_item_sources[$i]}" ]; then
      copy_hash_paths+=("${copy_item_sources[$i]}")
      copy_hash_items+=("$i")
      copy_hash_targets+=(0)
    fi
    if [ "${copy_item_present[$i]}" -eq 1 ] && [ -f "${copy_item_targets[$i]}" ] && [ -r "${copy_item_targets[$i]}" ]; then
      copy_hash_paths+=("${copy_item_targets[$i]}")
      copy_hash_items+=("$i")
      copy_hash_targets+=(1)
    fi
  done
  if [ "${#copy_hash_paths[@]}" -gt 0 ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      hash_output="$(sha256sum -- "${copy_hash_paths[@]}" 2>/dev/null)" || hash_output=""
    elif command -v shasum >/dev/null 2>&1; then
      hash_output="$(shasum -a 256 -- "${copy_hash_paths[@]}" 2>/dev/null)" || hash_output=""
    else
      hash_output=""
    fi
    hash_index=0
    while IFS= read -r hash_line; do
      [ "$hash_index" -lt "${#copy_hash_items[@]}" ] || break
      index="${copy_hash_items[$hash_index]}"
      hash="${hash_line:0:64}"
      if [ "${copy_hash_targets[$hash_index]}" -eq 1 ]; then
        copy_item_observed_hashes[$index]="$hash"
      else
        copy_item_source_hashes[$index]="$hash"
      fi
      hash_index=$((hash_index + 1))
    done <<< "$hash_output"
  fi

  for ((i = 0; i < ${#copy_item_ids[@]}; i++)); do
    hash="${copy_item_source_hashes[$i]}"
    source_final_lf=0
    if [ "${copy_item_kinds[$i]}" != script ] \
      && { [ "${copy_item_present[$i]}" -eq 1 ] || copy_item_is_required "${copy_item_ids[$i]}"; }; then
      source_final_lf="$(file_ends_with_lf "${copy_item_sources[$i]}")" || source_final_lf=0
    fi
    copy_item_final_lf+=("$source_final_lf")
    copy_item_statuses+=("")
    copy_item_reasons+=("")
    status=""
    reason=""

    if [ -z "$hash" ]; then
      status=unreadable
      reason=unreadable-file
    elif [ "${copy_item_present[$i]}" -eq 1 ]; then
      target="${copy_item_targets[$i]}"
      if [ ! -f "$target" ] || [ ! -r "$target" ]; then
        status=unreadable
        reason=unreadable-file
      else
        hash="${copy_item_observed_hashes[$i]}"
        if [ -z "$hash" ]; then
          status=unreadable
          reason=unreadable-file
        elif [ "${copy_item_kinds[$i]}" != script ]; then
          source_fm="$(read_front_matter "${copy_item_sources[$i]}")" || source_fm=""
          target_fm="$(read_front_matter "$target")" || target_fm=""
          if [ -z "$source_fm" ] || [ -z "$target_fm" ]; then
            status=unreadable
            reason=front-matter-unreadable
          fi
        fi
      fi
    elif copy_item_is_required "${copy_item_ids[$i]}"; then
      if [ "${copy_item_kinds[$i]}" != script ]; then
        source_fm="$(read_front_matter "${copy_item_sources[$i]}")" || source_fm=""
        if [ -z "$source_fm" ]; then
          status=unreadable
          reason=front-matter-unreadable
        fi
      fi
      if [ -z "$status" ]; then
        status=missing
        reason=required
      fi
    else
      status=not-deployed
    fi

    if [ -z "$status" ]; then
      # Git for Windows の grep はパターンの CR を落とすことがあるので、CR は tr で数える。
      if [ "${copy_item_ids[$i]}" = script:codex-agent.sh ] \
        && [ "$(tr -cd '\r' <"${copy_item_targets[$i]}" | head -c 1 | wc -c)" -gt 0 ]; then
        status=stale
        reason=line-ending
      elif cmp -s <(copy_item_content_stream "$i") <(normalize_copy_stream <"${copy_item_targets[$i]}"); then
        status=match
      else
        status=stale
        reason=content-differs
      fi
    fi
    copy_item_statuses[$i]="$status"
    copy_item_reasons[$i]="$reason"
  done

  if command -v git >/dev/null 2>&1; then
    head="$(GIT_OPTIONAL_LOCKS=0 git -C "$checkout" rev-parse HEAD 2>/dev/null)" || head=""
    git_paths=(
      ":(literal)tools/codex-agent.sh"
      ":(literal)tools/codex-agent-hook.js"
      ":(glob).claude/agents/*.md"
      ":(glob).claude/gpt-agents/*.md"
    )
    git_status="$(GIT_OPTIONAL_LOCKS=0 git -C "$checkout" status --porcelain --untracked-files=all -- "${git_paths[@]}" 2>/dev/null)" || git_status_ok=0
    if [ "$git_status_ok" -eq 1 ]; then
      if [ -n "$git_status" ]; then dirty=true; else dirty=false; fi
    else
      dirty=null
    fi
  fi

  print_check_copies_json "$checkout" "$head" "$dirty"
}

print_describe_json() {
  describe_status=""
  describe_launch_exit=null
  describe_status="${resolve_status:-ok}"
  [ -z "$resolve_launch_exit" ] || describe_launch_exit="$resolve_launch_exit"

  printf '{"protocol":1,"status":'
  json_quote "$describe_status"
  printf ',"reason":'
  json_nullable "$resolve_reason"
  printf ',"launch_exit":%s,"message":' "$describe_launch_exit"
  json_nullable "$resolve_message"
  printf ',"agent":'
  json_quote "$agent_name"
  printf ',"definition":{"user":'
  json_nullable "${definition_user:+$(to_windows_path "$definition_user")}"
  printf ',"project":'
  json_nullable "${definition_project:+$(to_windows_path "$definition_project")}"
  printf ',"project_applied":%s},"model":' "$project_applied"
  json_nullable "$codex_model"
  printf ',"model_source":'
  json_nullable "$model_source"
  printf ',"effort":'
  json_nullable "$codex_effort"
  printf ',"effort_source":'
  json_nullable "$effort_source"
  printf ',"sandbox":'
  json_nullable "$codex_sandbox"
  printf ',"approval_policy":"never","codex_home":'
  json_nullable "$codex_home"
  printf ',"workdir":'
  json_nullable "$workdir"
  printf '}\n'
}

if [ "$check_copies_mode" -eq 1 ]; then
  check_copies
  exit 0
fi

if [ "$describe_mode" -eq 1 ]; then
  describe_saved_status=""
  describe_saved_reason=""
  describe_saved_message=""
  describe_saved_path=""
  describe_saved_launch_exit=""
  load_agent_definition || true
  describe_saved_status="$resolve_status"
  describe_saved_reason="$resolve_reason"
  describe_saved_message="$resolve_message"
  describe_saved_path="$resolve_path"
  describe_saved_launch_exit="$resolve_launch_exit"
  if [ -n "$codex_home" ]; then
    check_agent_runtime paths || true
    if [ -n "$describe_saved_status" ]; then
      resolve_status="$describe_saved_status"
      resolve_reason="$describe_saved_reason"
      resolve_message="$describe_saved_message"
      resolve_path="$describe_saved_path"
      resolve_launch_exit="$describe_saved_launch_exit"
    fi
  elif [ -z "$resolve_status" ]; then
    check_agent_runtime paths || true
  fi
  print_describe_json
  exit 0
fi

if ! load_agent_definition; then
  if [ "$resolve_status" = disabled ]; then
    die_missing "$resolve_message"
  fi
  die "$resolve_message"
fi
if ! check_agent_runtime paths; then
  die "$resolve_message"
fi

# 依頼文は標準入力から読む。端末から起動されたときは待ち続けてしまうので先に止める。
[ -t 0 ] && die "依頼文が標準入力から渡されていない"
request="$(cat)"
case "$request" in
  *[![:space:]]*) ;;
  *) die "依頼文が空である" ;;
esac

prompt_workdir=""
prompt_workdir_ignored=""
workdir_from_prompt=0
if [ "$codex_sandbox" != "read-only" ]; then
  parsed_workdir="$(parse_prompt_workdir "$request")"
  case "${parsed_workdir:0:1}" in
    P) prompt_workdir="${parsed_workdir:1}" ;;
    I) prompt_workdir_ignored="not-absolute:${parsed_workdir:1}" ;;
    H) prompt_workdir_ignored="placeholder:${parsed_workdir:1}" ;;
  esac
fi

if [ -n "$prompt_workdir" ]; then
  expanded_prompt_workdir="$(expand_prompt_workdir "$prompt_workdir")"
  if [ -n "$workdir_option" ]; then
    if [ "$(normalize_workdir_for_compare "$expanded_prompt_workdir")" != "$(normalize_workdir_for_compare "$workdir_option")" ]; then
      workdir_mismatch="codex-agent: warning=workdir-mismatch prompt=$prompt_workdir option=$workdir_option"
    fi
  else
    workdir="$(to_windows_path "$expanded_prompt_workdir")"
    [ -d "$workdir" ] || die "依頼文から読み取った作業ディレクトリが存在しない: $workdir"
    workdir_from_prompt=1
  fi
fi

prompt_audit_line=""
if [ -f /proc/self/fd/0 ]; then
  prompt_input_file="$(readlink /proc/self/fd/0 2>/dev/null || true)"
  case "$prompt_input_file" in
    ''|*$'\n'*|*$'\r'*) prompt_input_file="" ;;
  esac
  if [ -n "$prompt_input_file" ] && [ -f "$prompt_input_file" ]; then
    prompt_hash_output="$(sha256sum -- "$prompt_input_file" 2>/dev/null)" || prompt_hash_output=""
    prompt_hash="${prompt_hash_output%% *}"
    case "$prompt_hash" in
      ''|*[!0-9a-fA-F]*) ;;
      *)
        if [ "${#prompt_hash}" -eq 64 ]; then
          prompt_audit_line="codex-agent: prompt-file=$(to_windows_path "$prompt_input_file") sha256=$prompt_hash"
        fi
        ;;
    esac
  fi
fi

if [ -n "$role_body" ]; then
  prompt="$role_body

---

## 依頼

$request"
else
  prompt="$request"
fi

audit_line="$(printf 'codex-agent: agent=%s model=%s effort=%s sandbox=%s codex_home=%s workdir=%s' \
  "$agent_name" "$codex_model" "$codex_effort" "$codex_sandbox" "$codex_home" "$workdir")"
printf '%s\n' "$audit_line"
workdir_notice_lines=""
[ "$workdir_from_prompt" -eq 0 ] || workdir_notice_lines="codex-agent: workdir-from=prompt"$'\n'
[ -z "${workdir_mismatch:-}" ] || workdir_notice_lines+="$workdir_mismatch"$'\n'
if [ -n "$prompt_workdir_ignored" ]; then
  workdir_notice_lines+="codex-agent: warning=prompt-workdir-ignored reason=${prompt_workdir_ignored%%:*} value=${prompt_workdir_ignored#*:}"$'\n'
fi
printf '%s' "$workdir_notice_lines"
[ -z "$prompt_audit_line" ] || printf '%s\n' "$prompt_audit_line"

# 試験用フック。フォールバック経路(終了コード 75)の確認にだけ使う。
# 通常の運用では設定しない。
if [ "${CODEX_AGENT_SIMULATE_RATE_LIMIT:-}" = "1" ]; then
  printf 'codex-agent: result=rate-limited (simulated)\n'
  exit 75
fi
if [ "${CODEX_AGENT_SIMULATE_UNAVAILABLE:-}" = "1" ]; then
  printf 'codex-agent: result=unavailable (simulated)\n'
  exit 75
fi

# 実行ログの置き場。Codex は推論の経過と実行したコマンドを標準エラーへ流すため、
# 受け取った全文をそのまま返すと呼び出し側のツール結果が肥大してファイルへ退避され、
# 報告を取り出せなくなる。全文はここへ残し、標準出力へは最終報告と監査用の行だけを出す。
# ログには Codex が読んだファイルの中身や実行結果が入りうる。
# 共有される一時ディレクトリ(`/tmp` など)に置くと、他の利用者から読まれる余地と、
# 先回りして置かれたシンボリックリンク越しに別のファイルを切り詰める余地が残る。
# ホーム配下は他の利用者が書き込めないため、置き場をここに取る。
mkdir -p "$log_dir" || die "実行ログの置き場を作れない: $log_dir"
# POSIX 権限が効く環境ではさらに本人だけが読める形に落とす。多重防御である。
chmod 700 "$log_dir" 2>/dev/null || true
# 残し続けると 1 回あたり数百 KB が溜まるため、古いものを落とす。
# 一時ファイルは通常は終了時に消すが、taskkill /F などで強制終了されると EXIT の trap が動かずに残るため、同じ規則で落とす。
find "$log_dir" -maxdepth 1 -type f \( -name '*.log' -o -name '*.last' -o -name '*.out' -o -name '*.status' -o -name '*.report' -o -name '*.report.tmp' \) \
  -mtime +7 -delete 2>/dev/null || true

# 定義がスクラッチパッドを使えないときに依頼文を置く場所。7 日を過ぎたファイルと codex-agent-* ディレクトリを消す。
# 置き場が無くても実行自体は続けられるため、作成に失敗しても止めない。
prompts_dir="$(to_slash "$home_dir")/.claude/codex-agent/prompts"
mkdir -p "$prompts_dir" 2>/dev/null || true
chmod 700 "$prompts_dir" 2>/dev/null || true
find "$prompts_dir" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null || true
find "$prompts_dir" -mindepth 1 -maxdepth 1 -type d -name 'codex-agent-*' -mtime +7 \
  -exec rm -rf -- {} + 2>/dev/null || true

# 実行 ID はログファイル名から拡張子を除いたものにする。run= の行と log= の行を突き合わせられるようにするためである。
run_id="$agent_name-$(date +%Y%m%d-%H%M%S)-$$"
log_base="$log_dir/$run_id"
log_file="$log_base.log"
# Codex の標準出力(最終回答)の受け皿。共有の一時ディレクトリではなくログ置き場に置く。
# 強制終了で残っても、実行 ID から特定して消せるうえ、古いものは上の削除で落ちるためである。
out_file="$log_base.out"
last_msg_file="$log_base.last"
status_file="$log_base.status"
# 標準出力へ出したものの写し。完了後に --wait が取り出す。
# 一時ファイルに書き、result= の行まで書いてから改名する。--wait が書きかけを読むと、途切れた報告を返すためである。
# Codex の起動前に止まる経路(終了コード 2、3、試験用フック)では作らない。ログも無く、--wait の対象にならないためである。
report_file="$log_base.report"
report_tmp="$log_base.report.tmp"
# 書き込み担当の目印のパス。置けたときだけ入る。
marker_file=""
# ログ本体と報告だけを残す。他は標準出力へ出すかログへ写した時点で役目を終える。
# 目印も終了時に消す。強制終了で残った目印は、次の起動が古い目印の規則で扱う。
trap 'rm -f "$out_file" "$last_msg_file" "$status_file" "$report_tmp"; [ -z "$marker_file" ] || rm -f "$marker_file" 2>/dev/null' EXIT
# 先に作って権限を落とす。あとの書き込みは truncate か追記なので、この権限が残る。
: >"$log_file" || die "実行ログを作れない: $log_file"
: >"$last_msg_file" || die "最終報告の受け皿を作れない: $last_msg_file"
: >"$out_file" || die "標準出力の受け皿を作れない: $out_file"
# 報告の写しは補助なので、作れなくても起動は止めない。
printf '%s\n%s' "$audit_line" "$workdir_notice_lines" 2>/dev/null >"$report_tmp" || true
if [ -n "$prompt_audit_line" ]; then
  printf '%s\n' "$prompt_audit_line" 2>/dev/null >>"$report_tmp" || true
fi
chmod 600 "$log_file" "$last_msg_file" "$out_file" "$report_tmp" 2>/dev/null || true

# 標準出力へ出す内容を、報告の写しにも書く。Codex の起動を決めた後の標準出力はすべてこれを通す。
out() {
  tee -a "$report_tmp" 2>/dev/null
}

# 止める対象を特定できるよう、Git Bash では Windows の PID を出す。
# taskkill が受け付けるのは Windows の PID であり、$$ は Git Bash 内の番号で一致しないためである。
run_pid="$$"
if [ -r "/proc/$$/winpid" ]; then
  winpid="$(cat "/proc/$$/winpid" 2>/dev/null)"
  case "$winpid" in
    ''|*[!0-9]*) ;;
    *) run_pid="$winpid" ;;
  esac
fi
run_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_line="codex-agent: run=$run_id pid=$run_pid started=$run_started_at"
printf '%s\n' "$run_line" >>"$log_file"

# Codex の起動前に出す。実行中に呼び出し側がログの場所と止める対象を知るための行である。
printf '%s\n' "$run_line" | out
log_line="codex-agent: log=$(to_windows_path "$log_file")"
printf '%s\n' "$log_line" | out

# 書き込み担当の目印の置き場を出す。git が無い、または作業ディレクトリが git の管理下に無いときは何も出さない。
# worktree ごとに置き場を分けるため、共通の git ディレクトリではなく worktree 固有の git ディレクトリを使う。
run_marker_dir() {
  local git_dir
  command -v git >/dev/null 2>&1 || return 0
  git_dir="$(git -C "$workdir" rev-parse --absolute-git-dir 2>/dev/null | tr -d '\r')"
  [ -n "$git_dir" ] && [ -d "$git_dir" ] || return 0
  printf '%s/codex-agent/runs' "$(to_slash "$git_dir")"
}

# 置き場にある他の目印を調べ、終わった実行の目印を消し、残っている実行ごとに警告の行を出す。
# 相手のログの最後の行が result= でなければ、--wait と同じプロセスの照合で強制終了の残りかを見分ける(判定は冒頭の説明にある)。
# ログが無い目印(7 日を過ぎたログの削除で消えた場合を含む)は、見分ける手がかりが無いので終わった実行として消す。
# check_run_markers <置き場>
check_run_markers() {
  local m other_id other_log last warning run_fields line state pids
  for m in "$1"/*.run; do
    [ -f "$m" ] || continue
    other_id="$(basename "$m" .run)"
    [ "$other_id" != "$run_id" ] || continue
    other_log="$(sed -n 's/\r$//; s/^codex-agent: log=//p' "$m" 2>/dev/null | head -n 1)"
    if [ -z "$other_log" ] || [ ! -f "$other_log" ]; then
      rm -f "$m" 2>/dev/null
      continue
    fi
    last="$(tail -n 1 "$other_log" 2>/dev/null | tr -d '\r')"
    case "$last" in
      "codex-agent: result="*)
        rm -f "$m" 2>/dev/null
        continue
        ;;
    esac
    run_fields="$(sed -n '1s/^codex-agent: run=[^ ]* pid=\([0-9][0-9]*\) started=\([^ ]*\).*$/\1 \2/p' "$m" 2>/dev/null | tr -d '\r')"
    [ -n "$run_fields" ] \
      || run_fields="$(sed -n '1s/^codex-agent: run=[^ ]* pid=\([0-9][0-9]*\) started=\([^ ]*\).*$/\1 \2/p' "$other_log" 2>/dev/null | tr -d '\r')"
    state="unknown"
    pids=""
    # --output-last-message の無い版の実行は、残った Codex を探せないので照合しない。
    if [ -n "$run_fields" ] && ! grep -qxF "$NO_LAST_MESSAGE_NOTE" <(tr -d '\r' <"$other_log" 2>/dev/null); then
      while IFS= read -r line; do
        case "$line" in
          wrapper=alive) state="alive" ;;
          wrapper=gone) state="gone" ;;
          codex=*) pids="${pids:+$pids,}${line#codex=}" ;;
        esac
      done < <(probe_run_processes "${run_fields%% *}" "${run_fields#* }" "$other_id")
    fi
    if [ "$state" = "gone" ] && [ -z "$pids" ]; then
      rm -f "$m" 2>/dev/null
      printf 'codex-agent: note=stale-run-marker-removed run=%s log=%s\n' "$other_id" "$other_log" >>"$log_file"
      continue
    fi
    warning="codex-agent: warning=concurrent-writer run=$other_id log=$other_log"
    printf '%s\n' "$warning" | out
    printf '%s\n' "$warning" >>"$log_file"
  done
  return 0
}

# 自分の目印を置く。一時ファイルに書いてから名前を変え、他の起動が書きかけの目印を読まないようにする。
# 置けなかったときは marker_file を空のままにし、起動は続ける。
# place_run_marker <置き場>
place_run_marker() {
  local tmp="$1/$run_id.run.tmp"
  if {
    printf '%s\n' "$run_line"
    printf '%s\n' "$log_line"
    printf 'codex-agent: agent=%s sandbox=%s\n' "$agent_name" "$codex_sandbox"
  } 2>/dev/null >"$tmp" && mv -f "$tmp" "$1/$run_id.run" 2>/dev/null; then
    marker_file="$1/$run_id.run"
  else
    rm -f "$tmp" 2>/dev/null
  fi
  return 0
}

# 目印を扱うのは書き込み可能な起動だけである。
# read-only の起動は worktree を書き換えないため、目印を置かず、他の目印も調べない。
# 目印の処理に失敗しても起動は止めない。目印は観測の補助であり、委譲そのものより優先しないためである。
if [ "$codex_sandbox" = "workspace-write" ]; then
  runs_dir="$(run_marker_dir)"
  if [ -n "$runs_dir" ] && mkdir -p "$runs_dir" 2>/dev/null; then
    check_run_markers "$runs_dir"
    place_run_marker "$runs_dir"
  fi
fi

# 失敗時と、最終報告を取り出せない場合に出すログの行数。
tail_lines=40

# 出したファイルが改行で終わっていないと、続く codex-agent: の行が同じ行に繋がって読めなくなる。
# Codex の最終報告は改行で終わらないことがある。
end_newline() {
  [ -s "$1" ] || return 0
  if [ -n "$(tail -c 1 "$1")" ]; then
    printf '\n'
  fi
  return 0
}

# result 行を標準出力とログの末尾の両方へ出して終わる。
# ログの最後の行を標準出力の最後の行と同じにし、ログだけで完了と結果を判定できるようにする。
# 報告の写しはログへ result= の行を書く前に改名する。ログが完了を示すときに報告が揃っているようにするためである。
# finish <result の値> <終了コード>
finish() {
  printf 'codex-agent: result=%s\n' "$1" | out
  mv -f "$report_tmp" "$report_file" 2>/dev/null || rm -f "$report_tmp" 2>/dev/null
  printf 'codex-agent: result=%s\n' "$1" >>"$log_file"
  exit "$2"
}

# ログから先頭の run= の行と warning= と note= の行を除いた本文を出す。
# 失敗時に標準出力へ出す末尾と、失敗の判定の対象には、これらの行を含めない。
# 前者は標準出力に同じ行を 2 回出さないため、後者は実行 ID、PID、ログのパスの数字が判定の語(429 など)に一致しうるためである。
log_body() {
  awk 'NR > 1 && !/^codex-agent: warning=/ && !/^codex-agent: note=/' "$log_file"
}

# --output-last-message は Codex の版によって無い。無い版ではログの末尾を報告の代わりに出す。
# 認証ホームはこの確認でも明示する。codex を呼ぶ経路に既定の ~/.codex への暗黙依存を残さない。
# ヘルプは変数に受けてから調べる。pipefail の下で grep -q へパイプすると、一致した時点で grep が終わり、
# 残りを書こうとした codex が SIGPIPE で失敗して、有る版でも無い版と判定されることがあるためである。
output_last_message=0
codex_help="$(env -u CODEX_AGENT_RUN CODEX_HOME="$codex_home" codex exec --help 2>/dev/null)"
case "$codex_help" in
  *--output-last-message*) output_last_message=1 ;;
esac
exit_grace_sec="${CODEX_AGENT_EXIT_GRACE_SEC:-60}"
case "$exit_grace_sec" in
  ''|*[!0-9]*) die "CODEX_AGENT_EXIT_GRACE_SEC は 0 以上の整数で指定する: $exit_grace_sec" ;;
esac
# 無い版では Codex のコマンドラインに <実行 ID>.last が載らず、--wait が残った Codex を探せない。
# その実行で「Codex は残っていない」と断定させないため、ログに目印を残す。
if [ "$output_last_message" -eq 0 ]; then
  printf '%s\n' "$NO_LAST_MESSAGE_NOTE" >>"$log_file"
fi

codex_args=(
  --skip-git-repo-check
  --sandbox "$codex_sandbox"
  -m "$codex_model"
  -c "model_reasoning_effort=\"$codex_effort\""
  -C "$workdir"
)
if [ "$output_last_message" -eq 1 ]; then
  codex_args+=(-o "$last_msg_file")
fi

# 認証ホームは常に明示する。既定の ~/.codex への暗黙依存を作らない。
# --dangerously-bypass-approvals-and-sandbox は付けない。
# 承認方針は never に固定する。このスクリプトは非対話の委譲専用で承認を返す相手がいないため、
# 呼び出し側の config.toml が on-request 等でも承認待ちで止まらないようにする。
# -c approval_policy=never は codex_args に入れず、この起動行に直接書く。
# ai-cross-review の cross-review.js は、codex exec の起動行の文字列(\ で続けた行を含む論理行)に
# この指定がある場合に限って bridge 経由を選ぶ。配列の中身までは追わないため、配列へ移すと直接起動へ戻ってしまう。
#
# 子孫が stderr を継承しても本体の終了を観測できるよう、収集側と本体を別々に待つ。
# exec で収集側を grep 自身にし、打ち切り時に待機するシェルを残さない。
rm -f "$status_file"
exec 3> >(exec grep --line-buffered -v -e '^WARNING' -e '^hook:' >>"$log_file" 2>/dev/null)
stderr_pid=$!
CODEX_AGENT_RUN="$run_id" CODEX_HOME="$codex_home" codex exec -c approval_policy=never "${codex_args[@]}" - <<<"$prompt" >"$out_file" 2>&3 3>&- &
codex_pid=$!
exec 3>&-
last_msg_written_at=-1
forced_codex_exit=0
while kill -0 "$codex_pid" 2>/dev/null; do
  sleep 1
  kill -0 "$codex_pid" 2>/dev/null || break
  if [ "$output_last_message" -eq 1 ] && [ -s "$last_msg_file" ]; then
    if [ "$last_msg_written_at" -lt 0 ]; then
      last_msg_written_at="$SECONDS"
    fi
    if [ "$((SECONDS - last_msg_written_at))" -ge "$exit_grace_sec" ]; then
      if stop_codex_run_processes; then
        forced_codex_exit=1
        break
      fi
    fi
  fi
done
wait "$codex_pid" 2>/dev/null
codex_status=$?
printf '%s\n' "$codex_status" >"$status_file"
chmod 600 "$status_file" 2>/dev/null || true
stderr_wait_started_at="$SECONDS"
stderr_truncated=0
while kill -0 "$stderr_pid" 2>/dev/null; do
  if [ "$((SECONDS - stderr_wait_started_at))" -ge "$exit_grace_sec" ]; then
    kill -9 "$stderr_pid" 2>/dev/null || true
    stderr_truncated=1
    break
  fi
  sleep 0.1
done
wait "$stderr_pid" 2>/dev/null || true
if [ "$forced_codex_exit" -eq 1 ]; then
  codex_status=0
  forced_exit_warning="codex-agent: warning=codex-exit-forced grace=$exit_grace_sec"
  printf '%s\n' "$forced_exit_warning" | out
  printf '%s\n' "$forced_exit_warning" >>"$log_file"
fi
if [ "$stderr_truncated" -eq 1 ]; then
  stderr_warning="codex-agent: warning=stderr-collection-truncated grace=$exit_grace_sec"
  printf '%s\n' "$stderr_warning" | out
  printf '%s\n' "$stderr_warning" >>"$log_file"
fi

# ツール接続の判定に使う経過(標準エラー)は、最終回答を写す前に取り出す。
# 最終回答も含めて判定すると、回答の本文に書かれた語で判定が反転する。
stderr_body="$(log_body)"

# 子プロセスの起動失敗の印を経過(標準エラー)だけで数える。最終回答が失敗を引用しても二重に数えないためである。
# 印は、Codex が起動したコマンドの失敗を示す出力の行の形に限って数える。MSYS2 の異常終了は行頭が変わるので、行の中の並びで照合する。
# 語だけで照合すると、Codex が読んだ文書の引用にも一致するためである。
# result= は変えない。ok を 75 に倒すと、GPT 側の実装を捨てて作り直すことになるためである。
child_spawn_failed="$(printf '%s\n' "$stderr_body" | awk '
  { lines[NR] = $0 }
  END {
    for (i = 1; i <= NR; i++) {
      line = lines[i]
      sub(/\r$/, "", line)
      if (line ~ /^[[:space:]]*(Execution failed: )?Error: spawn EPERM[[:space:]]*$/ &&
          i < NR &&
          lines[i + 1] ~ /^[[:space:]]*at ChildProcess[.]spawn [(]/) {
        print lines[i]
      } else if (lines[i] ~ /^[[:space:]]*exited -1073741502 in [0-9]/) {
        print lines[i]
      } else if (line ~ /sh [(][0-9]+[)] .*sh[.]exe: [*][*][*] fatal error - CreateFileMapping .*Win32 error 5[.].*Terminating[.]/) {
        print line
      }
    }
  }
')"
if [ -n "$child_spawn_failed" ]; then
  child_spawn_warning="codex-agent: warning=child-spawn-failed count=$(printf '%s\n' "$child_spawn_failed" | wc -l | tr -d ' ')"
  printf '%s\n' "$child_spawn_warning" | out
  printf '%s\n' "$child_spawn_warning" >>"$log_file"
  # MSYS2 の異常終了の行は Windows アカウントの SID を含む。報告から PR などへ写されうるため伏せる。
  first_line="$(printf '%s\n' "$child_spawn_failed" | head -n 1 | tr -d '\r' | sed -E 's/S-1-5-21-[0-9-]+/S-1-5-21-<SID>/g')"
  printf 'codex-agent: child-spawn-failed evidence: %s\n' "${first_line:0:300}" | out
fi

# エラー文を出さずに Checking File Globs の直後で終わった MSBuild の回を数え、根拠には起動したコマンドの行を出す。
# 終わりの判定は、次の空でない行が Codex の経過の区切りの行であることで行う。字下げの無いエラー文が続いた失敗を数えないためである。
# 判定の形は docs/gpt-agents.md「既知の制約」の「サンドボックスの中の MSBuild が…」にある。result= は変えない。
sandbox_build_failed="$(printf '%s\n' "$stderr_body" | awk '
  { sub(/\r$/, ""); lines[NR] = $0 }
  END {
    for (i = 2; i <= NR; i++) {
      if (lines[i] !~ /^[[:space:]]*exited [1-9][0-9]* in [0-9]/) continue
      j = i + 1
      while (j <= NR && (lines[j] ~ /^[[:space:]]*$/ || lines[j] ~ /^MSBuild/)) j++
      if (j > NR || lines[j] !~ /^[[:space:]]+Checking File Globs[[:space:]]*$/) continue
      k = j + 1
      while (k <= NR && lines[k] ~ /^[[:space:]]*$/) k++
      if (k > NR || lines[k] ~ /^(exec|codex|user|apply patch|tokens used|diff --git )/) print lines[i - 1]
    }
  }
')"
if [ -n "$sandbox_build_failed" ]; then
  sandbox_build_warning="codex-agent: warning=sandbox-build-failed count=$(printf '%s\n' "$sandbox_build_failed" | wc -l | tr -d ' ')"
  printf '%s\n' "$sandbox_build_warning" | out
  printf '%s\n' "$sandbox_build_warning" >>"$log_file"
  first_line="$(printf '%s\n' "$sandbox_build_failed" | head -n 1)"
  printf 'codex-agent: sandbox-build-failed evidence: %s\n' "${first_line:0:300}" | out
fi

# 経過(標準エラー)に続けて最終回答(標準出力)をログへ写す。
cat "$out_file" >>"$log_file"
# 最終回答が改行で終わらなくても、あとで追記する result= の行が独立した行になるようにする。
end_newline "$log_file" >>"$log_file"

# 根拠は 1 行ずつ接頭辞を付けて出す。
# 呼び出し側の定義は result 行の直前に evidence 行が来ることを前提にしているため、
# 接頭辞の無い行を間に挟まない。
emit_evidence() {
  printf '%s\n' "$2" | while IFS= read -r line; do
    [ -n "$line" ] || continue
    printf 'codex-agent: %s evidence: %s\n' "$1" "$line"
  done
}

# 終了コード 0 でも、ツール接続が一度も成立しなかった実行は依頼を果たしていないため 75 に倒す。
# この ERROR 行は先頭にタイムスタンプが付くため、行頭でなく行内の ERROR で照合する。
# ツール実行の成功行(" succeeded in ")が 1 行でもあれば、接続が復旧して作業できたとみなし ok のままにする。
# 本文は変数に受けてから調べる。pipefail の下で grep -q へパイプすると、書き手が SIGPIPE で失敗して判定が反転しうるためである。
if [ "$codex_status" -eq 0 ]; then
  matched="$(printf '%s\n' "$stderr_body" | grep -E 'ERROR' | grep -F 'code-mode host exited during handshake' | head -n 3)"
  if [ -n "$matched" ] && [[ "$stderr_body" != *' succeeded in '* ]]; then
    log_body | tail -n "$tail_lines" | out
    emit_evidence 'unavailable' "$matched" | out
    finish unavailable 75
  fi
fi

if [ "$codex_status" -eq 0 ]; then
  if [ -s "$last_msg_file" ]; then
    { cat "$last_msg_file"; end_newline "$last_msg_file"; } | out
  else
    # --output-last-message が無い版では、最終回答が流れる標準出力を報告の代わりに出す。
    { tail -n "$tail_lines" "$out_file"; end_newline "$out_file"; } | out
  fi
  finish ok 0
fi

# 失敗したときは原因を追えるようにする。ログの末尾だけを出す。
# 全文を出すと、肥大を避けるためにログへ移した意味がなくなる。
# この時点のログにはまだ result= の行が無いため、標準出力の result= の行は最後の 1 回だけになる。
# ログは直前に改行で終わる形に揃えてあるため、続く行が繋がらない。
log_body | tail -n "$tail_lines" | out

# 判定の対象は、失敗を告げる行と出力の末尾に絞る。
# ログには Codex が読んだファイルの中身も流れるため、全文を対象にすると
# テストデータに含まれる文字列で誤検出する。
# 末尾も残すのは、失敗の通知が ERROR で始まらない版があり得るためである。
# 末尾に読み込んだ内容が来ていれば誤検出は残るが、誤検出の結果は Claude 側での実装であり、
# 検出漏れ(作業がそこで止まる)より軽い。
# 抽出と末尾で同じ行が二重に入るため、重複は落とす。
evidence="$(
  {
    log_body | grep -iE '^[[:space:]]*(ERROR|stream error)'
    log_body | tail -n 10
  } 2>/dev/null | awk '!seen[$0]++'
)"

# 利用上限の通知は標準出力に出ることも標準エラーに出ることもあるため、両方を見る。
# 429 は単語境界で照合する。ID や桁数の一致で誤検出しないためである。
# 一致した行を残し、フォールバックの根拠を報告から追えるようにする。
matched="$(printf '%s\n' "$evidence" | grep -iE 'usage limit|rate limit|too many requests|\b429\b' | head -n 3)"
if [ -n "$matched" ]; then
  emit_evidence 'rate-limit' "$matched" | out
  finish rate-limited 75
fi

# 利用上限のほかにも、呼び出し側では直せない GPT 側の事情で実行できないことがある。
# これらは引数や定義の不備と違って呼び出し側で直せないため、利用上限と同じ終了コード 75 を返し、
# 呼び出し側が Claude へ倒せるようにする。理由は result 行で区別する。
# 並べる語は実際に観測したものだけにする。広く取ると、Codex の通常の失敗まで倒れてしまう。
matched="$(printf '%s\n' "$evidence" | grep -iE 'at capacity' | head -n 3)"
if [ -n "$matched" ]; then
  emit_evidence 'unavailable' "$matched" | out
  finish unavailable 75
fi

# Codex 自身の 75 は、GPT 側が使えないことを示す 75 と区別できないため 1 に写像する。
# 元の値は result 行に残す。
if [ "$codex_status" -eq 75 ]; then
  finish "failed exit=$codex_status" 1
fi
finish "failed exit=$codex_status" "$codex_status"
}

# main の後ろにコードを置かない。この行までを読み終えてから実行が始まる。
main "$@"; exit $?
