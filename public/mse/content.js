/* ============================================================
   MSE 작성 보조 도구 — 문구 파일  (content.js)
   ------------------------------------------------------------
   화면에 나오는 임상 문구·옵션·가이드는 전부 이 파일에 있습니다.
   메모장으로 열어 큰따옴표 " " 안의 글자만 고치고 저장한 뒤
   EXE를 닫았다 다시 실행하면 반영됩니다.
   ※ 저장할 때 인코딩을 반드시 UTF-8 로 두세요.
   ※ 고치기 전에 이 파일의 복사본을 남겨 두세요.

   // [검토 필요] 주석이 붙은 문구는 구현계획서 5장에 예시가 없어
   기계적으로 만들어 넣은 문장입니다. 팀장·선임 검토 후 고쳐 주세요.

   구조
     version   : 화면 아래에 표시되는 버전. 고치면 README 버전 기록에도 한 줄.
     sections  : MHIS 탭 순서대로 10개.
       groups    : 화면에 뜨는 입력 묶음.  options 는 그 안의 버튼.
         def:true    화면을 열었을 때 미리 선택되는 값(★기본값)
         normal:true 정상/없음 쪽 값. 회색으로 표시되고 '이상 없음' 판정에 쓰임
         hidden:true 다른 옵션을 골랐을 때만 나타나는 그룹
         reveal:[]   이 옵션을 고르면 나타나는 그룹 id
         mid / end   문장 조각. 뒤에 다른 조각이 이어지면 mid, 문장을 끝내면 end
         noun        나열용 낱말 조각
       frames    : 반복해서 쓰는 세부 입력 틀(환각·망상·자타해사고)
       outputs   : 문장 틀. {  } 안은 값이 채워지는 자리
       guide     : ⓘ 를 눌렀을 때 나오는 설명
   ============================================================ */

const CONTENT = {

  version: "3.3",

  // ----------------------------------------------------------
  // 화면에 뜨는 버튼·라벨 문구. 여기만 고치면 화면 글자가 바뀝니다.
  // ----------------------------------------------------------
  ui: {
    chipAlreadyAdded: "이미 들어 있는 예시 문장입니다.",
    copyEarlier: "복사는 완료됐지만 그동안 내용이 바뀌었습니다. 최신 내용이 필요하면 다시 복사하세요.",
    sectionNavigation: "항목 이동",
    previousSection: "← 이전",
    nextSection: "다음 →",
    confirmNext: "확인하고 다음 →",
    viewResult: "이 항목 결과",
    backToInput: "입력으로 이동",
    progressLabel: "확인한 항목 수",
    clipboardHelp: "복사·저장 안내",
    resetDone: "새 기록을 작성할 준비가 됐습니다.",
    reverted: "자동 생성 문장으로 되돌렸습니다. [실행 취소]로 수정 내용을 복구할 수 있습니다.",
    undo: "실행 취소",
    expandText: "넓게 보기",
    shrinkText: "줄여 보기",
    characters: "자",
    copyPendingBrief: "미확인 항목 {n}개 — 기본 선택이 실제 면담 내용에 맞는지 확인하세요.",
    copyMissingBrief: "미입력 {n}곳 — 빈 항목 표시가 기록에 포함될 수 있습니다.",
    copyProceed: "현재 내용으로 계속할까요? (내용이 바뀌기 전까지 같은 안내는 반복하지 않습니다.)",
    copySuccess: "복사했습니다. 원하는 기록 칸에 붙여넣으세요.",
    askCopySection: "이 항목은 아직 확인하지 않았습니다. 기본 선택과 문장이 실제 면담 내용에 맞는지 확인했나요?",
    askCopyStale: "직접 수정한 문장 중 현재 선택과 비교가 필요한 내용이 있습니다. [기록 검토]에서 확인하는 것을 권장합니다. 현재 문장 그대로 복사할까요?",
    nextPending: "미확인 찾기",
    review: "기록 검토",
    reviewNote: "미확인·미입력·위험 신호를 확인한 뒤 기록을 옮기세요. 항목 이름을 누르면 입력 위치로 이동합니다. 기본 선택은 실제로 확인한 소견과 일치하는지 검토하세요.",
    reviewReady: "미확인 항목과 표시된 미입력이 없습니다. 아래 문장이 실제 면담 내용과 일치하는지 마지막으로 확인하세요.",
    previewFull: "전체 기록 미리보기",
    previewSummary: "요약문 미리보기",
    staleEdit: "선택 내용이 바뀌었습니다. 직접 수정한 문장과 현재 선택이 일치하는지 확인하세요.",
    compareGenerated: "현재 선택으로 만든 문장 비교",
    copying: "복사 중…",
    copyRetry: "복사 재시도",
    transferCopied: "복사했습니다. 해당 칸에 붙여넣은 뒤 다음으로 이동하세요.",
    confirm: "이 항목 확인 ✓",
    confirmed: "확인됨 ✓",
    must: "필수 확인",
    required: "필수",
    defaultMark: "기본",
    questions: "질문 보기",
    guide: "가이드",
    guideHeads: {
      definition: "정의",
      criteria: "판단 기준",
      observation: "관찰 포인트",
      questions: "확인 질문",
      examples: "서술 예시",
      mistakes: "흔한 실수"
    },
    selectPlaceholder: "— 선택 —",
    add: "＋ {label} 추가",
    remove: "삭제",
    unconfirmed: "미확인",
    edited: "직접 수정됨",
    counter: "미확인 {n}/{total}",
    checkLead: "MHIS 체크 · ",
    slotDefault: "붙여넣을 텍스트",
    opinionLabel: "기타 의견",
    copy: "복사",
    copied: "복사됨",
    copyAll: "전체 복사",
    copySummary: "요약문 복사",
    // [v2.0] MHIS 에 옮겨 적기 — 한 칸씩 복사해 주며 어느 탭의 어느 칸인지 알려 준다
    transfer: "MHIS에 옮겨 적기",
    transferTitle: "MHIS에 옮겨 적기  {i} / {n}",
    transferCheck: "MHIS {tab} 탭에서 아래 항목을 체크하세요. (붙여넣을 것은 없습니다)",
    transferPaste: "MHIS {tab} 탭 — {field} 칸에 붙여넣으세요 (Ctrl+V). 아래 복사 상태를 확인한 뒤 붙여넣으세요.",
    transferRecopy: "다시 복사",
    transferPrev: "← 이전",
    transferNext: "다음 →",
    transferFinish: "끝내기",
    transferDone: "옮겨 적기를 마쳤고 현재 클립보드를 비웠습니다. 운영체제의 클립보드 기록은 별도로 관리하세요.",
    transferDoneNoClear: "다 옮겼습니다. 이 환경에서는 클립보드를 비울 수 없으니, 다른 글자를 한 번 복사해 두세요.",
    clipboardNote: "복사한 내용은 붙여넣은 뒤에도 클립보드에 남습니다. 프로그램(exe)을 닫을 때 마지막에 복사한 문장이 그대로 남아 있으면 지웁니다. 브라우저로 열었거나 다른 것을 이어서 복사했다면 남을 수 있으니, 공용 PC 에서는 다른 글자를 한 번 복사해 두세요.",
    revert: "자동 생성으로 되돌리기",
    reset: "초기화",
    // [v2.1] 예시 대상자 — 처음 쓰는 사람이 5분 안에 감을 잡도록. 가상 인물이며 저장 기능이 아니다
    example: "예시 불러오기",
    askExample: "가상의 예시 대상자(환청·피해망상·자살사고)를 불러옵니다. 지금 입력한 내용은 지워집니다. 계속할까요?",
    exampleNote: "지금 보이는 것은 가상의 예시 대상자입니다. 실제 기록에 쓰지 말고, [초기화] 뒤 실제 대상자를 입력하세요",
    askCopyExample: "지금 결과는 가상의 예시 대상자입니다. 실제 기록(MHIS)에 붙여넣으면 안 됩니다. 그래도 복사할까요?",
    fold: "접기",
    unfold: "펴기",
    missing: "[미입력]",
    missingWarn: "미입력 {n}곳 · 표시된 내용을 확인해 주세요",
    askCopyMissing: "[미입력] {n}곳이 그대로 복사됩니다. 계속할까요?",
    none: "없음",
    footer: "화면 v{app} · 문구 v{v} · 초안 보관 상태는 하단에서 확인하세요",
    // [v1.7] index.html 과 content.js 의 판이 어긋났을 때 (한쪽만 덮어쓴 경우)
    versionMismatch: "화면(v{app})과 문구(v{v})의 판이 다릅니다 — 배포 파일을 폴더째 다시 복사한 뒤 담당자에게 알려 주세요",
    noContent: "content.js 를 읽지 못했습니다. index.html 과 content.js 가 같은 폴더에 있는지 확인하세요.",
    askReset: "모든 입력을 기본값으로 되돌립니다. 계속할까요?",
    askRevert: "직접 수정한 내용을 버리고 자동 생성 문장으로 되돌립니다. 계속할까요?",
    askCopyAll: "아직 확인하지 않은 항목이 {n}개 있습니다. 미확인 항목에도 기본 선택 문장이 포함될 수 있습니다. 실제 면담 내용과 일치하는지 확인한 뒤 복사하세요. 현재 내용으로 계속할까요?",
    copyFail: "복사에 실패했습니다. 직접 선택해 복사하세요."
  },

  // ----------------------------------------------------------
  // [전체 복사] 출력 모양 (구현계획서 6.2). {  } 자리에 값이 들어갑니다.
  // ----------------------------------------------------------
  format: {
    header: "[MSE] {date}",
    checkMark: "☑ ",
    opinionLine: " - 기타 의견: {text}",
    lines: [
      { sec: "appearance", head: "1) 외관", slot: "main" },
      { sec: "attitude",   head: "2) 태도: {check}" },
      { sec: "behavior",   head: "3) 행동: {check}" },
      { sec: "speech",     head: "4) 언어: {check}" },
      { sec: "mood",       head: "5) 기분: {check}" },
      { sec: "perception", head: "6) 지각: {check}", slot: "main" },
      { sec: "thought",    head: "7) 사고: {check}", sub: [
          " - Delusion: {delStatus} / {slot:delusion}",
          " - 자타해사고: {shStatus} / {slot:selfharm}",
          " - 기타: {slot:etc}"
        ] },
      { sec: "cognition",  head: "8) 인지: {check}", slots: true },
      { sec: "judgment",   head: "9) 판단력: {status} / {slot:main}" },
      { sec: "insight",    head: "10) Insight: {check}" }
    ]
  },

  // ----------------------------------------------------------
  // [v2.1] 예시 대상자 — [예시 불러오기] 버튼이 채우는 값. 구현계획서 부록 B-2 의 가상 사례.
  // 실제 인물이 아니며, 처음 쓰는 사람이 화면과 결과를 한눈에 보게 하려는 것.
  // ----------------------------------------------------------
  example: {
    label: "예시 대상자 (가상) — 환청·피해망상·자살사고",
    values: {
      "appearance/gender": "m", "appearance/age_band": "a50",
      "appearance/apparent_age": "older", "appearance/build": "thin",
      "appearance/hair": ["messy", "greasy"], "appearance/hygiene": "poor", "appearance/odor": ["alcohol"],
      "appearance/dress_fit": ["season"], "appearance/dress_fit_text": "한여름에 두꺼운 외투", "appearance/dress_neat": ["dirty"],
      "appearance/expression": ["flat", "tense"], "appearance/eye_contact": ["avoid"], "appearance/posture": ["stooped"],
      "appearance/wearing": ["mask"], "appearance/side_effect": ["tremor"],
      "attitude/attitude": ["cooperative", "guarded"],
      "speech/spontaneity": "nonspontaneous", "speech/productivity": "decreased", "speech/rate": "slow",
      "speech/pitch": "low", "speech/tone": "monotonous",
      "mood/mood": ["depressed", "anxious"], "mood/mood_text": "요즘 아무 의욕이 없어요", "mood/mood_score": 3,
      "mood/affect_fit": "appropriate", "mood/affect_type": ["blunted"],
      "perception/hallucination": ["auditory"],
      "perception/hallu@auditory/content": "2~3명이 자신을 욕하는 목소리", "perception/hallu@auditory/freq": "w3",
      "perception/hallu@auditory/context": ["night", "alone"], "perception/hallu@auditory/onset": "약 2개월 전",
      "perception/hallu@auditory/reaction": "real", "perception/hallu@auditory/impact": ["talk"],
      "perception/hallu@auditory/command": "no",
      "thought/form": "appropriate", "thought/delusion": "yes",
      "thought/delusion#0/type": "persecutory", "thought/delusion#0/content": "윗집 사람들이 나를 감시하고 도청한다",
      "thought/delusion#0/conviction": "firm", "thought/delusion#0/onset": "약 6개월 전",
      "thought/delusion#0/impact": ["other"], "thought/delusion#0/impact_text": "경찰에 2회 신고하고 창문을 가리고 지냄",
      "thought/selfharm": "yes", "thought/selfharm/si": "yes", "thought/selfharm/si_text": "차라리 없어지는 게 낫겠다",
      "thought/selfharm/si_freq": "almost", "thought/selfharm/plan": "no", "thought/selfharm/means": "no",
      "thought/selfharm/intent": "mid", "thought/selfharm/past": "yes", "thought/selfharm/past_text": "1회(2024년)",
      "thought/selfharm/protective": "어머니, 반려견", "thought/selfharm/hi": "no",
      "judgment/judgment": "impaired",
      "judgment/judgment_actual": "약 복용 중단 시 재발 위험을 알면서도 자의로 2주간 중단했고, 생활비를 받은 당일 대부분 소진함",
      "insight/insight": "g3"
    }
  },

  sections: [
  /* ===== 1) 외관 (General Appearance) ===== */
  {
    id: "appearance",
    order: 1,
    title_ko: "외관",
    title_en: "General Appearance",
    mhis: "text",
    required_confirm: true,

    guide: {
      definition: "면담실에 들어올 때부터 나갈 때까지 눈에 보이는 것. 해석하지 말고 본 대로 씀.",
      criteria: "위생·복장·표정·시선·자세와 움직임을 실제로 관찰한 범위에서 기록합니다. 기본 선택은 확인 전 초안입니다. 연령·문화·생활 여건과 평소 모습도 고려하고, 식별에 불필요한 외모 묘사는 줄입니다.",
      observation: "본 모습과 확인한 설명을 구분합니다. 복장·화장·눈맞춤만으로 질환이나 자기관리 능력을 단정하지 않습니다. 떨림·경직은 관찰한 움직임을 먼저 적고 복약·신체 상태를 확인합니다. 술 냄새와 실제 음주 여부도 구분합니다.",
      questions: [],
      questions_note: "관찰이 중심입니다. 달라진 모습이나 원인이 궁금하면 본인에게 확인하고, 답변은 출처를 붙여 기타 의견에 기록합니다.",
      // [검토 필요] v1.1 개정 후 도구가 실제로 만드는 문장. 계획서 v1.0 원문 예시와 다름
      examples: [
        "실제 연령에 맞게 보이는 보통 체격의 40대 남성임. 동행인 없이 혼자 내소함. 머리는 단정하게 정돈되어 있고 전반적인 위생 관리 상태 양호함. 계절과 상황에 맞는 옷을 단정하게 입고 있음. 표정은 자연스러움. 면담자와 눈을 잘 마주치며 시선 접촉 적절함. 면담하는 동안 상체를 세운 자세를 유지하고 걸음걸이에 특별한 이상은 없음. 안색과 영양 상태 모두 양호해 보임.",
        "머리는 헝클어져 있고 기름져 있음. 전반적인 위생 관리 상태가 불량하고 술 냄새가 남.",
        "한여름에 두꺼운 외투를 입고 있어 계절에 맞지 않고 옷에 오염이 있음.",
        "표정은 무표정하고 긴장한 기색이 있음. 면담자와 눈을 거의 마주치지 않고 시선을 피함.",
        "면담하는 동안 어깨와 상체를 앞으로 굽힌 자세임. 걸음이 느림.",
        "안색이 창백하고 수척해 보임.",
        "피부에 상처가 있고 긁힌 자국이 있음.",
        "마스크를 착용하고 있음. 왼쪽 팔에 오래된 흉터가 관찰됨. 손 떨림과 침 흘림이 관찰됨. 피곤해 보임.",
      ],
      mistakes: "인상적인 세부(머리 모양, 눈 모양)만 쓰고 위생·복장·시선을 빠뜨림. 이전 평가와 달라진 점은 자유 기술에 씀(예: '지난 방문 대비 위생 상태 악화').",
      // 명세 5.1 "문장 생성 규칙(순서 고정, 그룹별 조각을 조립)"
      extra: [
        { t: "1. 첫 문장", d: "[겉보기 연령] [체격] [키] [연령대] [성별]임. 기본: 실제 연령에 맞게 보이는 보통 체격의 40대 남성임. 이상: 실제 연령보다 많아 보이는 마른 체격에 키가 작은 편인 50대 여성임. (키가 '보통'이면 키 조각 생략)" },
        { t: "2. 위생", d: "기본: 머리는 정돈되어 있고 전반적 위생 상태 양호함. 이상 예: 머리는 헝클어지고 기름져 있으며, 손톱이 길고 더러움. 전반적 위생 상태 불량하고 술 냄새가 남." },
        { t: "3. 복장", d: "기본: 계절과 상황에 맞는 단정한 복장임. 이상 예: 한여름에 두꺼운 외투를 입고 있어 계절에 맞지 않으며, 옷이 오염되어 있음." },
        { t: "4. 표정·시선", d: "기본: 표정은 자연스럽고 시선 접촉 적절함. 이상 예: 표정은 무표정하고 긴장되어 있으며, 시선 접촉을 회피함." },
        { t: "5. 자세·걸음", d: "자세는 상체·어깨·팔다리 위치를 구체적으로 적습니다. 예: 어깨와 상체를 앞으로 굽혀 앉아 있음. 걸음이 느림. 이동을 실제로 본 범위와 보조기구 사용을 구분하고, 휠체어 사용만으로 보행 능력을 단정하지 않습니다." },
        { t: "6. 특이 소견", d: "착용물 '안경과 마스크를 착용함.' + 외상 '왼쪽 팔에 오래된 흉터 있음.' + 문신 + 부작용 '손 떨림과 침 흘림이 관찰됨.' + 건강 인상(기본이 아닐 때만) '피곤해 보임.' / 선택하지 않은 내용을 포괄하여 '특이 소견 없음'으로 자동 보충하지 않습니다." },
        { t: "7. 자유 기술", d: "입력 그대로(끝에 마침표 보정)." },
        { t: "9. 추가된 관찰 항목", d: "직접 본 모습만 선택하고, 평소와 달라진 점은 비교 시점과 함께 적습니다. 화장·문신·종교 관련 물건·반려동물 동반 자체를 이상 소견으로 해석하지 않습니다. 영양·체중·부작용의 원인은 별도 확인이 필요합니다." },
      ],
    },

    groups: [

      // [v2.1] 면담 날짜 — 비우면 오늘. 어제 방문한 것을 오늘 정리할 때처럼 기록일과 면담일이 다를 때 쓴다
      {
        id: "interview_date",
        label: "면담 날짜 (비우면 오늘)",
        type: "date",
        guide: "전체 복사 머리글 [MSE] 날짜에 들어갑니다. 비워 두면 오늘 날짜가 들어갑니다.", // [검토 필요] 파생 문구
      },

      // [v2.0] 면담 형태 — MHIS 개별상담의 '형태'와 같은 선택지.
      // 전화·사이버 상담은 외관을 볼 수 없으므로 아래 관찰 항목을 숨기고 "관찰하지 못함"이 나간다.
      {
        id: "contact_mode",
        label: "면담 형태",
        type: "single",
        guide: "전화와 사이버(문자 등 영상이 없는 상담)는 직접 본 외관 문장을 생성하지 않습니다. 현재 사이버 선택은 영상 면담용이 아닙니다. 가정방문이면 동행 문장이 방문 상황에 맞게 바뀝니다.",
        options: [
          { id: "visit_center", ko: "내소", en: "", def: true, normal: true },
          { id: "home", ko: "방문(가정)", en: "", normal: true },
          { id: "phone", ko: "전화", en: "" },
          { id: "online", ko: "사이버", en: "" },
        ],
      },

      // [v2.1] 외관 문단 길이 — 매주 하는 개별상담 기록은 '간단히', 사전평가·6개월 재평가는 '자세히'.
      // 이상 소견은 어느 쪽이든 전부 나가고, '간단히'는 정상일 때의 문장(동행·표정·시선·자세·안색)만 줄인다
      {
        id: "detail_level",
        label: "외관 문단",
        type: "single",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        guide: "자세히는 선택한 정상 소견까지 포함하고, 간단히는 정상 표정·시선·자세·안색 등의 문장을 줄입니다. 선택한 특이사항과 자유 기술은 두 방식 모두 유지합니다. 기록 목적과 실제 관찰 범위에 맞게 선택하세요.", // [검토 필요] 파생 문구
        options: [
          { id: "full", ko: "자세히", en: "", def: true, normal: true },
          { id: "brief", ko: "간단히", en: "", normal: true },
        ],
      },

      // 성별 — 필수. '여'를 고르면 수염 옵션이 숨겨짐
      {
        id: "gender",
        label: "①-1 성별",
        type: "single",
        required: true,
        options: [
          { id: "m", ko: "남", en: "", noun: "남성" },
          { id: "f", ko: "여", en: "", noun: "여성" },
        ],
      },

      // 연령대 — 필수. 첫 문장의 '40대' 자리에 그대로 들어감
      {
        id: "age_band",
        label: "①-2 연령대",
        type: "single",
        required: true,
        options: [
          { id: "a10", ko: "10대", en: "", noun: "10대" },
          { id: "a20", ko: "20대", en: "", noun: "20대" },
          { id: "a30", ko: "30대", en: "", noun: "30대" },
          { id: "a40", ko: "40대", en: "", noun: "40대" },
          { id: "a50", ko: "50대", en: "", noun: "50대" },
          { id: "a60", ko: "60대", en: "", noun: "60대" },
          { id: "a70p", ko: "70대 이상", en: "", noun: "70대 이상" },
        ],
      },

      // 겉보기 연령 — 첫 문장 맨 앞 조각
      {
        id: "apparent_age",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "①-3 겉보기 연령",
        type: "single",
        options: [
          { id: "same", ko: "실제 연령과 비슷", en: "", def: true, normal: true, mid: "실제 연령에 맞게 보이는" },
          { id: "older", ko: "많아 보임", en: "", mid: "실제 연령보다 많아 보이는" },
          { id: "younger", ko: "적어 보임", en: "", mid: "실제 연령보다 적어 보이는" }, // [검토 필요] 파생 문구
        ],
      },

      // 체격 — 첫 문장의 '보통 체격' 자리
      {
        id: "build",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "①-4 체격",
        guide: "겉으로 보이는 체격을 적습니다. 외관만으로 과체중·비만을 진단하지 않으며, 측정한 키·체중이 있다면 값과 시점을 별도로 기록합니다.",
        type: "single",
        options: [
          { id: "normal", ko: "보통", en: "", def: true, normal: true, noun: "보통 체격" },
          { id: "thin", ko: "마른", en: "", noun: "마른 체격" },
          { id: "over", ko: "체격이 큰 편", en: "", noun: "큰 편의 체격" }, // [검토 필요] 파생 문구
          { id: "obese", ko: "체격이 매우 큰 편", en: "", noun: "매우 큰 편의 체격" }, // [검토 필요] 파생 문구
        ],
      },

      // 키 — '보통'이면 첫 문장에서 키 조각을 아예 뺌
      {
        id: "height",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "①-5 키",
        type: "single",
        options: [
          { id: "normal", ko: "보통", en: "", def: true, normal: true },
          { id: "short", ko: "작은 편", en: "", noun: "키가 작은 편" },
          { id: "tall", ko: "큰 편", en: "", noun: "키가 큰 편" }, // [검토 필요] 파생 문구
        ],
      },

      // 동행 — 혼자 왔는지 누구와 왔는지. 첫 문장 다음에 한 문장으로 나감
      // [검토 필요] 계획서 5.1 표에 없는 항목. 부록 A 칩 '보호자 동행'을 그룹으로 올린 것
      {
        id: "accompanied",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "①-6 동행 (누구와 왔는지)",
        type: "multi",
        exclusiveNormal: true,
        guide: "혼자 왔는지, 누가 함께 왔는지는 주거 안정과 지지체계를 보는 단서가 됨.", // [검토 필요] 파생 문구
        options: [
          { id: "alone", ko: "혼자 옴", en: "", def: true, normal: true, end: "동행인 없이 혼자 내소함" }, // [검토 필요] 파생 문구
          { id: "family", ko: "가족 동행", en: "", noun: "가족" }, // [검토 필요] 파생 문구
          { id: "agency", ko: "기관·담당자 동행", en: "", noun: "기관 담당자" }, // [검토 필요] 파생 문구
          { id: "other_acc", ko: "그 외", en: "", reveal: ["accompanied_text"], noun: "{text}", noun_notext: "동행인" }, // [검토 필요] 파생 문구
        ],
      },

      // 위 '그 외'를 고르면 나타나는 칸
      {
        id: "accompanied_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "누구와 함께 왔는지",
        type: "text",
        hidden: true,
        placeholder: "이름 대신 관계로 적으세요 (예: 이웃 주민, 통장)", // [검토 필요] 파생 문구 — 개인정보가 남지 않도록 이름을 적지 않게 안내
      },

      // 전반 청결 — 위생 문장의 뒷부분
      {
        id: "hygiene",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "②-1 전반 청결",
        type: "single",
        guide: "위생 저하 → 자기관리 저하(우울·음성증상 가능)",
        options: [
          { id: "good", ko: "양호", en: "", def: true, normal: true, mid: "전반적인 위생 관리 상태 양호하고", end: "전반적인 위생 관리 상태 양호함" }, // [검토 필요] 파생 문구 — 계획서 원문은 "전반적 위생 상태 …"
          { id: "fair", ko: "보통", en: "", mid: "전반적인 위생 관리 상태 보통이고", end: "전반적인 위생 관리 상태 보통임" }, // [검토 필요] 파생 문구
          { id: "poor", ko: "불량", en: "", mid: "전반적인 위생 관리 상태가 불량하고", end: "전반적인 위생 관리 상태가 불량함" }, // [검토 필요] 파생 문구 — 계획서 원문은 "전반적 위생 상태 …"
        ],
      },

      // 머리 — 위생 문장의 앞부분('머리는'으로 시작). 정돈됨은 다른 것과 같이 못 고름
      {
        id: "hair",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "②-2 머리",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "tidy", ko: "정돈됨", en: "", def: true, normal: true, mid: "단정하게 정돈되어 있고", end: "단정하게 정돈되어 있음" }, // [검토 필요] 파생 문구('정돈되어 있고'를 늘림)
          { id: "messy", ko: "헝클어짐", en: "", mid: "헝클어져 있고", end: "헝클어져 있음" }, // [검토 필요] 파생 문구
          { id: "greasy", ko: "기름짐", en: "", mid: "기름져 있고", end: "기름져 있음" },
          // standalone: true — 이 조각은 "머리는 …" 문장 안에 끼지 않고 별도의 한 문장으로 나감
          { id: "odd", ko: "특이 머리(염색·삭발 등)", en: "", reveal: ["hair_odd_text"], standalone: true, mid: "{text}", end_notext: "머리 모양이 특이함" },
        ],
      },

      // 위 '특이 머리'를 고르면 나타나는 칸
      {
        id: "hair_odd_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "특이 머리(염색·삭발 등)",
        type: "text",
        hidden: true,
        placeholder: "어떤 머리인지 — 한 문장으로 (예: 머리를 노란색으로 염색함)", // [검토 필요] 파생 문구
      },

      // 수염·손톱 — 성별이 '여'면 수염 옵션은 화면에서 숨김
      {
        id: "beard_nail",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "②-3 수염·손톱",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "none", ko: "특이 없음", en: "", def: true, normal: true },
          // 수염 상태 — 성별이 '여'면 화면에서 숨김
          { id: "beard_kept", conflicts: ["beard"], ko: "수염 있음(정돈됨)", en: "", showIf: { group: "gender", notIn: ["f"] }, mid: "수염을 길렀으나 정돈되어 있고", end: "수염을 길렀으나 정돈되어 있음" }, // [검토 필요] 파생 문구
          { id: "beard_bushy", ko: "수염 덥수룩함", en: "", showIf: { group: "gender", notIn: ["f"] }, mid: "수염이 덥수룩하고", end: "수염이 덥수룩함" }, // [검토 필요] 파생 문구
  { id: "beard", ko: "수염 지저분함", en: "", showIf: { group: "gender", notIn: ["f"] }, mid: "수염이 정돈되어 있지 않고", end: "수염이 정돈되어 있지 않음" }, // [검토 필요] 파생 문구
          { id: "nail", ko: "손톱 길고 더러움", en: "", mid: "손톱이 길고 때가 끼어 있고", end: "손톱이 길고 때가 끼어 있음" }, // [검토 필요] 파생 문구('손톱이 길고 더러움'을 늘림)
        ],
      },

      // 체취 — 위생 문장 끝에 붙음
      {
        id: "odor",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "②-4 체취",
        type: "multi",
        exclusiveNormal: true,
        guide: "술 냄새 → 음주 여부 확인",
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "bad", ko: "불쾌한 체취", en: "", noun: "불쾌한 체취" }, // [검토 필요] 파생 문구
          { id: "alcohol", ko: "술 냄새", en: "", noun: "술 냄새" }, // [검토 필요] 파생 문구('술 냄새가 남'을 늘림)
          { id: "smoke", ko: "담배 냄새", en: "", noun: "담배 냄새" },
          // 진한 향수·화장품 냄새. 과도한 치장과 함께 조증 삽화에서 보일 수 있음
          { id: "perfume", ko: "진한 향수·화장품 냄새", en: "", noun: "진한 향수 냄새" },  // [검토 필요] 파생 문구 // [검토 필요] 파생 문구
        ],
      },

      // 구강·치아 — 이상이 있을 때만 한 문장으로 나감
      // [검토 필요] 계획서 5.1 표에 없는 항목
      {
        id: "oral",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "②-5 구강·치아",
        type: "multi",
        exclusiveNormal: true,
        guide: "직접 확인한 치아·구강 소견과 불편 호소를 구분합니다. 치아 결손이나 구취만으로 자기관리 저하의 원인·기간을 단정하지 않습니다.", // [검토 필요] 파생 문구
        options: [
          { id: "none", ko: "특이 없음", en: "", def: true, normal: true },
          { id: "missing", ko: "치아 결손", en: "", mid: "치아가 빠진 곳이 있고", end: "치아가 빠진 곳이 있음" }, // [검토 필요] 파생 문구
          { id: "damaged", ko: "치아 손상", en: "", mid: "일부 치아가 손상되어 있고", end: "일부 치아가 손상되어 있음" }, // [검토 필요] 파생 문구
          { id: "halitosis", ko: "구취", en: "", mid: "구취가 있고", end: "구취가 있음" }, // [검토 필요] 파생 문구
          { id: "gum", ko: "잇몸 상태 불량", en: "", mid: "잇몸 상태가 좋지 않고", end: "잇몸 상태가 좋지 않음" }, // [검토 필요] 파생 문구
        ],
      },

      // 화장·몸단장 — 이상이 있을 때만 한 문장으로 나감
      // [검토 필요] 계획서 5.1 표에 없는 항목
      {
        id: "grooming",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "②-6 화장·몸단장",
        type: "multi",
        exclusiveNormal: true,
        guide: "화장 여부나 장신구 취향 자체는 질환의 근거가 아닙니다. 상황·문화·평소 모습과 비교하고, 기록에 필요한 구체적인 특징만 적습니다.", // [검토 필요] 파생 문구
        options: [
          { id: "fit", ko: "연령·상황에 맞음", en: "", def: true, normal: true },
          { id: "plain", ko: "화장 없음", en: "", mid: "화장을 하지 않은 상태이고", end: "화장을 하지 않은 상태임" }, // [검토 필요] 파생 문구
          // [v2.2] "전혀 하지 않음" 과 "과도함" 은 같이 적을 수 없다
          { id: "excessive", ko: "눈에 띄는 화장·장신구", en: "", conflicts: ["plain"], mid: "화장이나 장신구가 눈에 띄고", end: "화장이나 장신구가 눈에 띔" }, // [검토 필요] 파생 문구
          { id: "odd_g", ko: "상황에 맞지 않음", en: "", mid: "화장이나 몸단장이 상황에 맞지 않고", end: "화장이나 몸단장이 상황에 맞지 않음" }, // [검토 필요] 파생 문구
        ],
      },

      // 복장 적절성 — 부적절을 고르면 '무엇을 입었나' 칸이 나타남
      {
        id: "dress_fit",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "③-1 복장 적절성",
        type: "multi",
        exclusiveNormal: true,
        guide: "실제 날씨·실내 환경과 입은 옷을 함께 적습니다. 복장만으로 판단력이나 자기관리 능력을 단정하지 않습니다.",
        options: [
          { id: "ok", ko: "계절·상황에 적절", en: "", def: true, normal: true, mid: "계절과 상황에 맞는 옷을 입고 있으나", end: "계절과 상황에 맞는 옷을 입고 있음" }, // [검토 필요] 파생 문구
          { id: "season", ko: "계절에 맞지 않음", en: "", reveal: ["dress_fit_text"], noun: "계절" },
          { id: "situation", ko: "상황에 맞지 않음", en: "", reveal: ["dress_fit_text"], noun: "상황" }, // [검토 필요] 파생 문구
        ],
      },

      // 복장이 부적절할 때 나타나는 칸
      {
        id: "dress_fit_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "무엇을 입었나",
        type: "text",
        hidden: true,
        placeholder: "무엇을 입었나 (예: 한여름에 두꺼운 외투)",
      },

      // 단정함 — 복장 문장의 뒷부분
      {
        id: "dress_neat",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "③-2 옷차림 상태",
        guide: "오염과 낡음은 구분합니다. 이전 버전의 ‘오염·낡음’ 선택은 ‘오염’으로 이어지므로 불러온 기록은 실제 관찰에 맞게 확인하세요. 새 선택 ‘낡음·해짐’으로 따로 적을 수 있습니다.",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "neat", ko: "단정", en: "", def: true, normal: true, end: "옷차림이 단정함" }, // [검토 필요] 파생 문구
          { id: "messy", ko: "흐트러짐", en: "", mid: "옷차림이 흐트러져 있고", end: "옷차림이 흐트러져 있음" }, // [검토 필요] 파생 문구
          { id: "dirty", ko: "오염", en: "", mid: "옷에 오염이 있고", end: "옷에 오염이 있음" },
          { id: "worn", ko: "낡음·해짐", en: "", mid: "옷이 낡거나 해진 부분이 있고", end: "옷이 낡거나 해진 부분이 있음" },
          // 계절·상황에는 맞지만 색이 지나치게 화려하거나 조합이 어울리지 않는 경우
          { id: "flashy", ko: "화려하거나 조합이 눈에 띔", en: "", mid: "옷차림이 화려하거나 조합이 눈에 띄고", end: "옷차림이 화려하거나 조합이 눈에 띔" },  // [검토 필요] 파생 문구 // [검토 필요] 파생 문구('옷이 오염되어 있음'을 늘림)
        ],
      },

      // 특이 복장 — '있음'을 고르면 아래 칸이 나타나고, 그 내용이 한 문장으로 나감
      {
        id: "dress_odd",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "③-3 특이 복장",
        type: "single",
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "yes", ko: "있음", en: "", reveal: ["dress_odd_text"] },
        ],
      },

      {
        id: "dress_odd_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "어떤 복장인지",
        type: "text",
        hidden: true,
        placeholder: "어떤 복장인지 — 한 문장으로 (예: 환자복 위에 겨울 외투를 입고 있음)", // [검토 필요] 파생 문구
      },

      // 표정 — '자연스러움'은 다른 것과 같이 못 고름. 뒤의 시선 접촉과 한 문장으로 이어짐
      {
        id: "expression",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "④ 표정",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "natural", ko: "자연스러움", en: "", def: true, normal: true, mid: "자연스럽고", end: "자연스러움" },
          { id: "flat", ko: "무표정", en: "", mid: "무표정하고", end: "무표정함" }, // [검토 필요] 파생 문구
          { id: "tense", ko: "긴장", en: "", mid: "긴장되어 보이고", end: "긴장되어 보임" }, // [검토 필요] 파생 문구
          { id: "gloomy", ko: "침울", en: "", mid: "침울해 보이고", end: "침울해 보임" }, // [검토 필요] 파생 문구
          { id: "anxious", ko: "불안", en: "", mid: "불안해 보이고", end: "불안해 보임" }, // [검토 필요] 파생 문구
          { id: "wary", ko: "경계", en: "", mid: "경계하는 듯 보이고", end: "경계하는 듯 보임" }, // [검토 필요] 파생 문구
          // [v2.2] "무표정함" 과 "미소나 웃음이 잦음" 은 한 문장에 같이 갈 수 없다.
          //        (침울 + 미소는 정서가 상황에 맞지 않는 소견으로 실제로 함께 관찰되므로 막지 않는다)
          { id: "smile", ko: "미소·웃음", en: "", conflicts: ["flat"], mid: "미소나 웃음이 잦고", end: "미소나 웃음이 잦음" }, // [검토 필요] 파생 문구
          { id: "frown", ko: "찡그림", en: "", mid: "찡그림이 잦고", end: "찡그림이 잦음" }, // [검토 필요] 파생 문구
          { id: "tired", ko: "피로", en: "", mid: "피로해 보이고", end: "피로해 보임" }, // [검토 필요] 파생 문구
        ],
      },

      // 시선 접촉 — 표정 문장의 뒷부분
      {
        id: "eye_contact",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑤ 시선 접촉",
        type: "multi",
        exclusiveNormal: true,
        // 회피·간헐적·과도한 응시는 같은 시선 양상을 서로 다르게 본 것이라 동시에 관찰될 수 없음. 하나만.
        onlyOneOf: ["avoid", "intermittent", "staring"],
        guide: "눈맞춤의 빈도와 지속을 관찰합니다. 문화·불편감·시각 문제 등 맥락을 고려하고, 눈맞춤만으로 정서나 태도를 단정하지 않습니다.",
        options: [
          { id: "ok", ko: "적절", en: "", def: true, normal: true, end: "면담자와 눈을 잘 마주치며 시선 접촉 적절함" }, // [검토 필요] 파생 문구('시선 접촉 적절함'을 늘림)
          { id: "avoid", ko: "회피(거의 마주치지 않음)", en: "", mid: "면담자와 눈을 거의 마주치지 않고", end: "면담자와 눈을 거의 마주치지 않고 시선을 피함" }, // [검토 필요] 파생 문구
          { id: "intermittent", ko: "간헐적", en: "", mid: "면담자와 눈을 마주쳤다 피했다 하고", end: "면담자와 눈을 마주쳤다 피했다 하여 시선 접촉이 간헐적임" }, // [검토 필요] 파생 문구
          { id: "staring", ko: "과도한 응시", en: "", mid: "면담자를 오래 응시하고", end: "면담자를 오래 응시함" }, // [검토 필요] 파생 문구
          // [v2.2] 면담자를 오래 응시하면서 동시에 허공을 볼 수는 없다. (회피 + 허공 응시는 함께 있을 수 있어 막지 않는다)
          { id: "vacant", ko: "허공 응시·초점 없음", en: "", conflicts: ["staring"], mid: "시선이 허공을 향한 채 초점이 없어 보이고", end: "시선이 허공을 향해 있고 초점이 없어 보임" }, // [검토 필요] 파생 문구
        ],
      },

      // 자세 — 뒤의 걸음걸이와 한 문장으로 이어짐
      {
        id: "posture",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑥-1 자세",
        type: "multi",
        exclusiveNormal: true,
        // 구부정·경직·축 처짐은 한 몸이 동시에 취할 수 없는 자세라 하나만.
        onlyOneOf: ["stooped", "rigid", "slumped"],
        options: [
          { id: "ok", ko: "상체를 세움", en: "", def: true, normal: true, mid: "면담하는 동안 상체를 세운 자세를 유지하고", end: "면담하는 동안 상체를 세운 자세를 유지함" }, // [검토 필요] 파생 문구
          { id: "stooped", ko: "구부정", en: "", mid: "면담하는 동안 어깨와 상체를 앞으로 굽히고", end: "면담하는 동안 어깨와 상체를 앞으로 굽힌 자세임" }, // [검토 필요] 파생 문구
          { id: "rigid", ko: "경직", en: "", mid: "몸이 굳은 듯 경직된 자세를 유지하고", end: "몸이 굳은 듯 경직된 자세를 유지함" }, // [검토 필요] 파생 문구
          { id: "slumped", ko: "축 처짐", en: "", mid: "몸에 힘이 없는 듯 축 처진 자세이고", end: "몸에 힘이 없는 듯 축 처진 자세임" }, // [검토 필요] 파생 문구
          // [v2.2] "경직된 자세를 유지" · "축 처진 자세" 와 "한 자세를 유지하지 못하고 계속 움직임" 은 한 문장에 같이 갈 수 없다.
          //        (구부정 + 계속 움직임은 실제로 함께 관찰되므로 막지 않는다)
          { id: "restless", ko: "계속 움직임", en: "", conflicts: ["rigid", "slumped"], mid: "한 자세를 유지하지 못하고 계속 몸을 움직이며,", end: "한 자세를 유지하지 못하고 계속 몸을 움직임" }, // [검토 필요] 파생 문구
        ],
      },

      // 걸음걸이 — '관찰 못 함'은 관찰하지 못했다고 그대로 적음
      {
        id: "gait",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑥-2 걸음걸이",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "normal", ko: "정상", en: "", def: true, normal: true, end: "걸음걸이에 특별한 이상은 없음" }, // [검토 필요] 파생 문구('걸음걸이 정상임'을 늘림)
          { id: "slow", ko: "느림", en: "", mid: "걸음이 느리고", end: "걸음이 느림" }, // [검토 필요] 파생 문구
          { id: "unstable", ko: "불안정", en: "", mid: "걸음이 불안정하고", end: "걸음이 불안정함" }, // [검토 필요] 파생 문구
          { id: "aid", ko: "보조기구 사용", en: "", mid: "지팡이 등 보조기구를 사용하고", end: "지팡이 등 보조기구를 사용하여 이동함" }, // [검토 필요] 파생 문구
          { id: "wheelchair", ko: "휠체어", en: "", mid: "휠체어를 이용하고", end: "휠체어를 이용하여 이동함" }, // [검토 필요] 파생 문구
          // 관찰 못 함 — 보지 못한 것을 '정상'으로 적지 않도록 그대로 기록함(요약문 판정에서는 이상 소견이 아님)
          { id: "notobserved", ko: "관찰 못 함", en: "", normal: true, notobserved: true, mid: "걸음걸이는 관찰하지 못하고", end: "걸음걸이는 관찰하지 못함" }, // [검토 필요] 파생 문구
        ],
      },

      // 안색 — 뒤의 영양 상태와 한 문장으로 이어짐
      // [검토 필요] 계획서 5.1 표에 없는 항목
      {
        id: "complexion",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-1 안색",
        type: "multi",
        exclusiveNormal: true,
        // 창백·붉음·황달기는 같은 얼굴빛을 두고 갈리는 판단이라 동시에 기록할 수 없음. 하나만.
        onlyOneOf: ["pale", "flushed", "jaundice"],
        guide: "조명과 가려진 범위를 고려해 보이는 안색을 적습니다. 변화가 있으면 본인 설명과 신체 상태를 확인하며, 얼굴빛만으로 빈혈·음주·간 질환을 단정하지 않습니다.", // [검토 필요] 파생 문구
        options: [
          { id: "normal", ko: "특이 없음", en: "", def: true, normal: true },
          // 확인 못 함 — 마스크 등으로 못 본 것을 '특이 없음'으로 적지 않도록 그대로 기록함(요약문 판정에서는 이상 소견이 아님)
          { id: "notobserved", ko: "확인 못 함(마스크 등)", en: "", normal: true, notobserved: true, mid: "마스크 착용 등으로 확인하지 못하고", end: "마스크 착용 등으로 확인하지 못함" }, // [검토 필요] 파생 문구
          { id: "pale", ko: "창백함", en: "", mid: "창백하고", end: "창백함" }, // [검토 필요] 파생 문구
          { id: "flushed", ko: "붉음", en: "", mid: "붉게 상기되어 있고", end: "붉게 상기되어 있음" }, // [검토 필요] 파생 문구
          { id: "jaundice", ko: "황달기", en: "", mid: "황달기가 보이고", end: "황달기가 보임" }, // [검토 필요] 파생 문구
          // [v2.2] 얼굴빛에 대한 판단이므로 창백·붉음·황달과 동시에 적을 수 없다 (onlyOneOf 세 값은 계약이라 짝으로 잇는다)
          { id: "dull", ko: "어둡고 푸석함", en: "", conflicts: ["pale", "flushed", "jaundice"], mid: "어둡고 푸석하며", end: "어둡고 푸석함" }, // [검토 필요] 파생 문구
        ],
      },

      // 영양 상태 — 안색 문장의 뒷부분
      // [검토 필요] 계획서 5.1 표에 없는 항목
      {
        id: "nutrition",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-2 영양 관련 외관 인상",
        guide: "외관상 인상을 기록하는 항목입니다. 실제 영양 상태나 수척해진 원인은 식사·측정 체중·변화 시점 등을 확인해 구분해서 적습니다.",
        type: "single",
        options: [
          { id: "good", ko: "양호", en: "", def: true, normal: true, end: "영양 상태 양호해 보임" }, // [검토 필요] 파생 문구
          { id: "fair", ko: "보통", en: "", end: "영양 상태는 보통으로 보임" }, // [검토 필요] 파생 문구
          { id: "poor", ko: "수척해 보임", en: "", end: "수척해 보임" }, // [검토 필요] 파생 문구
        ],
      },

      // 피부 — 이상이 있을 때만 한 문장으로 나감
      // [검토 필요] 계획서 5.1 표에 없는 항목
      {
        id: "skin",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-3 피부 상태",
        type: "multi",
        exclusiveNormal: true,
        guide: "상처·긁힌 자국·멍은 자해나 낙상, 폭력 피해의 단서가 될 수 있으므로 본 대로 기록하고 경위를 확인함.", // [검토 필요] 파생 문구
        options: [
          { id: "none", ko: "특이 없음", en: "", def: true, normal: true },
          { id: "rash", ko: "발진·트러블", en: "", mid: "발진이 있고", end: "발진이 있음" }, // [검토 필요] 파생 문구
          { id: "wound", ko: "상처", en: "", mid: "상처가 있고", end: "상처가 있음" }, // [검토 필요] 파생 문구
          { id: "scratch", ko: "긁힌 자국", en: "", mid: "긁힌 자국이 있고", end: "긁힌 자국이 있음" }, // [검토 필요] 파생 문구
          { id: "bruise", ko: "멍", en: "", mid: "멍이 있고", end: "멍이 있음" }, // [검토 필요] 파생 문구
          { id: "dry", ko: "건조·각질", en: "", mid: "건조하고 각질이 일어난 부위가 있고", end: "건조하고 각질이 일어난 부위가 있음" }, // [검토 필요] 파생 문구
        ],
      },

      // 착용물
      {
        id: "wearing",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-4 착용물",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "glasses", ko: "안경", en: "", noun: "안경" },
          { id: "mask", ko: "마스크", en: "", noun: "마스크" },
          { id: "hat", ko: "모자", en: "", noun: "모자" },
          { id: "hearingaid", ko: "보청기", en: "", noun: "보청기" },
          // 부적·호일·여러 겹의 마스크 등. 망상과 관련된 착용물일 수 있음
          { id: "odd_wear", ko: "특이한 착용물(부적·호일 등)", en: "", reveal: ["wearing_text"], noun: "{text}", noun_notext: "특이한 착용물" },  // [검토 필요] 파생 문구
        ],
      },

      // 위 '특이한 착용물'을 고르면 나타나는 칸
      {
        id: "wearing_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "어떤 착용물인지",
        type: "text",
        hidden: true,
        placeholder: "무엇을 착용하고 있는지 (예: 은박지로 감싼 모자)", // [검토 필요] 파생 문구
      },

      // 외상·흉터
      {
        id: "injury",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-5 외상·흉터",
        type: "single",
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "yes", ko: "있음", en: "", reveal: ["injury_text"] },
        ],
      },

      {
        id: "injury_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "부위·양상",
        type: "text",
        hidden: true,
        placeholder: "부위·양상 (예: 왼쪽 팔에 오래된 흉터)",
      },

      // 문신
      {
        id: "tattoo",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-6 문신",
        type: "single",
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "yes", ko: "있음", en: "", reveal: ["tattoo_text", "tattoo_shape"] },
        ],
      },

      {
        id: "tattoo_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "부위",
        type: "text",
        hidden: true,
        placeholder: "부위 (예: 오른쪽 팔뚝)",
      },

      // 문신 모양 — 부위와 함께 한 문장이 됨
      {
        id: "tattoo_shape",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "모양",
        type: "text",
        hidden: true,
        placeholder: "무슨 모양인지 (예: 용, 글씨, 별)", // [검토 필요] 파생 문구
      },

      // 약물 부작용 의심 소견 — 행동 섹션과 함께 보고 주치의와 공유할 항목
      {
        id: "side_effect",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-7 떨림·경직 등 신체 소견",
        type: "multi",
        exclusiveNormal: true,
        guide: "관찰한 움직임을 먼저 적습니다. 복용약·발생 시점·기존 질환 등을 함께 확인하며, 이 선택만으로 약물 부작용을 확정하지 않습니다. 필요한 경우 주치의와 공유합니다.",
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "tremor", ko: "손 떨림", en: "", noun: "손 떨림" },
          { id: "drooling", ko: "침 흘림", en: "", noun: "침 흘림" },
          { id: "rigidity", ko: "근육 경직·둔한 움직임", en: "", noun: "근육 경직·둔한 움직임" },
          { id: "akathisia", ko: "안절부절", en: "", noun: "안절부절못하는 모습" },
          { id: "oculogyric", ko: "눈이 위로 돌아감", en: "", noun: "눈이 위로 돌아가는 모습" },
        ],
      },

      // 건강 인상
      {
        id: "health",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-8 건강 인상",
        guide: "체중 변화는 측정값이나 본인 설명 등 근거가 있을 때 선택하고, 시점·변화량·정보 출처를 기타 의견에 적습니다. 외모만으로 실제 체중 변화를 확정하지 않습니다.",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "healthy", ko: "건강해 보임", en: "", def: true, normal: true },
          { id: "sick", ko: "병약해 보임", en: "", mid: "병약해 보이고", end: "병약해 보임" }, // [검토 필요] 파생 문구
          { id: "tired", ko: "피곤해 보임", en: "", mid: "피곤해 보이고", end: "피곤해 보임" }, // [검토 필요] 파생 문구
          { id: "weight", ko: "체중 변화(근거 확인)", en: "", mid: "눈에 띄는 체중 변화가 있고", end: "눈에 띄는 체중 변화가 있음" }, // [검토 필요] 파생 문구
        ],
      },

      // 소지품 — 이상이 있을 때만 한 문장으로 나감
      // [검토 필요] 계획서 5.1 표에 없는 항목
      {
        id: "belongings",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑦-9 소지품",
        type: "multi",
        exclusiveNormal: true,
        guide: "소지품의 종류·양과 면담에 미친 영향을 필요한 범위에서 적습니다. 물건·종교적 상징·반려동물만으로 주거 상태나 정신 증상을 판단하지 않습니다.", // [검토 필요] 파생 문구
        options: [
          { id: "none", ko: "특이 없음", en: "", def: true, normal: true },
          { id: "many", ko: "짐이 많음", en: "", mid: "소지품이 많고", end: "소지품이 많음" }, // [검토 필요] 파생 문구
          { id: "plastic", ko: "비닐봉지 여러 개", en: "", mid: "비닐봉지를 여러 개 들고 있고", end: "비닐봉지를 여러 개 들고 있음" }, // [검토 필요] 파생 문구
          { id: "pet", ko: "반려동물 동반", en: "", mid: "반려동물을 동반하였고", end: "반려동물을 동반함" },
          // 아래 둘은 망상·종교적 몰두와 함께 나타나는 경우가 있어 관찰 대상으로 둠
          { id: "religious", ko: "종교·주술 관련 물건", en: "", mid: "종교·주술 관련 물건을 지니고 있고", end: "종교·주술 관련 물건을 지니고 있음" },  // [검토 필요] 파생 문구
          { id: "notes", ko: "메모·기록물 뭉치", en: "", mid: "메모나 기록물 뭉치를 들고 있고", end: "메모나 기록물 뭉치를 들고 있음" }, // [검토 필요] 파생 문구
        ],
      },

      // 자유 기술 — 위 항목으로 담기지 않는 것을 그대로 적음. 칩은 계획서 부록 A
      // ('보호자 동행' 칩은 ①-6 동행 그룹으로 올렸으므로 칩에서 뺌 — 부록 A가 칩 추가·삭제를 허용함)
      {
        id: "free_text",
        showIf: { group: "contact_mode", notIn: ["phone", "online"] },
        label: "⑧ 자유 기술",
        type: "text",
        long: true,
        placeholder: "위 항목으로 담기지 않는 것을 한 문장으로 적음",
        chips: [
          "면담 내내 휴대폰을 확인함",
          "눈이 충혈되어 있음",
          "입술이 건조함",
          "땀을 많이 흘림",
          "손을 계속 만지작거림",
          "지난 방문에 비해 위생 상태가 나빠짐",
          "지난 방문에 비해 호전됨",
        ],
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    outputs: {
      // ① 첫 문장 — 키가 '보통'이면 키 조각을 뺀 s1_no_height 를 씀
      s1_no_height: "{apparent} {build}의 {age} {gender}임",
      s1_height: "{apparent} {build}에 {height}인 {age} {gender}임",
      // ② 위생 문장을 여는 말
      hair_lead: "머리는",
      // ①-6 동행 — 고른 것들을 이어 붙임
      accompanied: "{list}{와과} 함께 내소함", // [검토 필요] 파생 문구
      // [v2.0] 면담 형태에 따른 문장
      visit_alone: "가정방문으로 면담함", // [검토 필요] 파생 문구
      visit_with: "가정방문으로 면담함. 자리에 {list}{이가} 함께 있음", // [검토 필요] 파생 문구 — [v2.0.1] 시제 통일
      s1_phone: "{age} {gender}임", // [검토 필요] 파생 문구 — 전화·사이버 상담에서는 겉보기 연령·체격을 알 수 없음
      not_observed_phone: "전화 상담으로 외관은 관찰하지 못함", // [검토 필요] 파생 문구
      not_observed_online: "비대면(사이버) 상담으로 외관은 관찰하지 못함", // [검토 필요] 파생 문구
      // ②-4 체취 — 고른 것들을 이어 붙임
      odor: "{list}{이가} 남", // [검토 필요] 파생 문구
      // ③-1 복장 — 계절·상황을 함께 고를 수 있음
      dress_bad: "{text}{을를} 입고 있어 {list}에 맞지 않음",
      dress_bad_mid: "{text}{을를} 입고 있어 {list}에 맞지 않고",
      dress_bad_notext: "{list}에 맞지 않는 옷을 입고 있음", // [검토 필요] 파생 문구
      dress_bad_notext_mid: "{list}에 맞지 않는 옷을 입고 있고", // [검토 필요] 파생 문구
      // ④ 표정 문장을 여는 말
      expr_lead: "표정은",
      // ⑦-3 피부 문장을 여는 말
      skin_lead: "피부에",
      // ⑦-1 안색 문장을 여는 말
      complexion_lead: "안색은",  // [검토 필요] 파생 문구
      // ⑦ 안색·영양이 모두 기본값일 때 쓰는 한 문장
      body_normal: "안색과 영양 상태 모두 양호해 보임", // [검토 필요] 파생 문구
      // ⑦ 특이 소견 조각들
      wearing: "{list}{을를} 착용하고 있음", // [검토 필요] 파생 문구('착용함'을 늘림)
      side_effect: "{list}{이가} 관찰됨",
      injury: "{text}{이가} 관찰됨", // [검토 필요] 파생 문구('있음'을 늘림)
      injury_notext: "외상 또는 흉터가 관찰됨", // [검토 필요] 파생 문구
      tattoo: "{text}에 문신이 있음",
      tattoo_both: "{part}에 {shape} 문신이 있음", // [검토 필요] 파생 문구
      tattoo_shape_only: "{shape} 문신이 있음", // [검토 필요] 파생 문구 // [검토 필요] 파생 문구
      tattoo_notext: "문신이 있음", // [검토 필요] 파생 문구
      dress_odd_notext: "특이한 복장을 하고 있음", // [검토 필요] 파생 문구
      none_special: "그 밖에 겉으로 드러나는 특이 소견은 없음", // [검토 필요] 파생 문구('그 외 특이 소견 없음'을 늘림)
      // ③ 복장이 전부 기본값일 때 쓰는 한 문장
      dress_normal: "계절과 상황에 맞는 옷을 단정하게 입고 있음", // [검토 필요] 파생 문구
      // 요약문(6.3)용 — 첫 문장을 "…남성으로" 로 바꿔 뒤 문장과 잇는다
      sum_prefix_no_height: "{apparent} {build}의 {age} {gender}{로으로}",
      sum_prefix_height: "{apparent} {build}에 {height}인 {age} {gender}{로으로}",
      sum_normal_tail: "위생·복장 양호함",
      sum_hygiene_normal: "위생 상태 양호함",
      sum_dress_normal: "계절과 상황에 맞는 단정한 복장임",
    },

    // 요약문(6.3)은 조립기가 만들므로 빈 문자열로 둠
    summary: { normal: "" },
  },

  /* ===== 2) 태도 (Attitude) ===== */
  {
    id: "attitude",
    order: 2,
    title_ko: "태도",
    title_en: "Attitude",
    mhis: "check",
    required_confirm: false,

    // 화면 오른쪽 ⓘ 가이드 (명세 5.2 "가이드 내용")
    guide: {
      definition: "면담자를 대하는 방식. 질문에 답하는 방식, 정보를 얼마나 여는지, 면담자에게 보이는 감정.",
      criteria: "면담 전체를 놓고 가장 두드러진 1~2개. 초반 guarded → 후반 cooperative처럼 변했으면 둘 다 체크하고 텍스트에 변화를 씀.",
      questions: [],
      questions_note: "없음(관찰 항목)",
      // 명세 5.2에는 "서술 예시" 문단이 따로 없어, 5.2 "결과 > 요약문용 문장(6.3)"의 두 예시를 그대로 옮김
      examples: [
        "면담 태도 협조적임.",
        "면담 태도는 협조적이나 조심스러운 편임.",
      ],
      mistakes: "말수가 적거나 시선을 피한다는 이유만으로 비협조적이라고 단정하지 않음. 면담 상황과 실제 반응을 함께 기록함.",
      // d(내용)는 명세 5.2 문장 그대로. t(소제목)는 화면 배치를 위해 붙인 이름임 // [검토 필요] 파생 문구
      extra: [
        { t: "MHIS 칸", d: "체크박스 10개(복수). 서술 칸 없음." },
        { t: "선택 개수", d: "보통 1~2개 선택. 이상 옵션을 고르면 아래에 \"구체적으로 어땠나\" 텍스트(선택)가 열림." },
        { t: "결과 체크 안내", d: "선택한 항목 영문명 그대로. 예 \"☑ cooperative, guarded\"" },
      ],
    },

    groups: [

      // 면담자를 대하는 태도 — 복수 선택. cooperative 가 기본값이며, 나머지를 고르면 아래 서술 칸이 열림.
      // exclusiveNormal 은 일부러 넣지 않음: 부록 B-2 "☑ cooperative, guarded"처럼 정상+이상 동시 선택이 정상 사용례임.
      {
        id: "attitude",
        label: "태도",
        type: "multi",
        options: [

          {
            id: "cooperative",
            ko: "협조적",
            en: "cooperative",
            def: true,
            normal: true,
            guide: "질문에 성실히 답하고 면담에 참여함. 대부분의 기본.",
            mid: "협조적이나",
            end: "협조적임",
          },

          {
            id: "submission",
            ko: "순종적",
            en: "submission",
            guide: "면담자 말에 지나치게 따르고 자기 의견을 내지 않음.",
            reveal: ["attitude_text"],
            mid: "순종적이고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "순종적임", // [검토 필요] 파생 문구
          },

          {
            id: "defensive",
            ko: "방어적",
            en: "defensive",
            guide: "질문을 공격으로 받아들여 변명·정당화함(\"왜 그런 걸 물으세요?\").",
            reveal: ["attitude_text"],
            mid: "방어적이고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "방어적임", // [검토 필요] 파생 문구
          },

          {
            id: "evasive",
            ko: "회피",
            en: "evasive",
            guide: "질문의 핵심을 피해 딴 얘기를 하거나 \"모르겠어요\"로 넘김.",
            reveal: ["attitude_text"],
            mid: "질문을 회피하는 편이고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "질문을 회피하는 편임", // [검토 필요] 파생 문구
          },

          {
            id: "attentive",
            ko: "경청",
            en: "attentive",
            guide: "면담자 말에 집중하고 반응함.",
            reveal: ["attitude_text"],
            mid: "면담자 말에 집중하고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "면담자 말에 집중함", // [검토 필요] 파생 문구
          },

          {
            id: "guarded",
            ko: "조심스러운",
            en: "guarded",
            guide: "답은 하되 최소한만, 경계하며 말을 고름. ↔ evasive는 질문 자체를 피함.",
            reveal: ["attitude_text"],
            mid: "조심스러운 편이고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "조심스러운 편임",
          },

          {
            id: "apathetic",
            ko: "무관심",
            en: "apathetic",
            guide: "면담에 관심 없음. 무엇을 물어도 \"네\", \"글쎄요\".",
            reveal: ["attitude_text"],
            mid: "무관심하고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "무관심함", // [검토 필요] 파생 문구
          },

          {
            id: "hostile",
            ko: "적대적",
            en: "hostile",
            guide: "화를 내거나 비난·위협적 언행.",
            reveal: ["attitude_text"],
            mid: "적대적이고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "적대적임", // [검토 필요] 파생 문구
          },

          {
            id: "playful",
            ko: "장난스러운",
            en: "playful",
            guide: "농담·장난으로 상황을 가볍게 만듦.",
            reveal: ["attitude_text"],
            mid: "장난스럽고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "장난스러움", // [검토 필요] 파생 문구
          },

          {
            id: "sarcastic",
            ko: "빈정대는",
            en: "sarcastic",
            guide: "비꼬는 말투.",
            reveal: ["attitude_text"],
            mid: "빈정대는 말투를 보이고", // [검토 필요] 파생 문구 — [v2.0] 둘 이상 고를 때의 연결형
            end: "빈정대는 말투를 보임", // [검토 필요] 파생 문구
          },

        ],
      },

      // cooperative 외의 태도를 고르면 열리는 서술 칸(선택). 태도가 면담 중 변한 경우도 여기에 씀.
      {
        id: "attitude_text",
        label: "구체적으로 어땠나", // [검토 필요] 화면 라벨은 명세에 없어 placeholder 와 같은 표현을 씀
        type: "text",
        hidden: true,
        placeholder: "구체적으로 어땠나",
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 요약문(6.3) 조립용 앞머리 문구
    outputs: {
      lead: "면담 태도는",
    },

    // 전부 기본값(cooperative)일 때 쓰는 정상 문장
    summary: {
      normal: "면담 태도 협조적임",
    },
  },

  /* ===== 3) 행동 (Behavior) ===== */
  {
    id: "behavior",
    order: 3,
    title_ko: "행동",
    title_en: "Behavior",
    mhis: "check",              // MHIS: 체크박스 14개(복수), '특이사항없음' 포함
    required_confirm: false,

    // 화면 오른쪽 ⓘ 가이드에 뜨는 설명 (명세 5.3 "가이드 내용")
    guide: {
      definition: "면담 중 관찰된 몸의 움직임(정신운동 활동). 대상자가 말한 것이 아니라 본 것.",
      criteria: "눈에 띄지 않으면 특이사항없음. 약 부작용으로 보이는 움직임(떨림·경직·안절부절)은 외관 ⑦-4에도 기록하고 주치의와 공유.",
      questions: [],
      questions_note: "없음(관찰 항목)",
      examples: [
        "행동상 특이사항 없음.",
        "면담 중 손을 계속 비비며 안절부절못하는 모습(agitation) 관찰됨.",
      ],
      mistakes: "관찰한 움직임과 대상자가 보고한 행동을 구분함. 한 가지 행동만으로 진단이나 원인을 단정하지 않음.",
      extra: [
        { t: "선택 규칙", d: "이상 항목을 하나라도 고르면 '특이사항없음'은 자동 해제. 반대로 '특이사항없음'을 고르면 나머지 해제." },  // [검토 필요] 파생 문구(소제목만 파생, 내용은 명세 그대로)
        { t: "결과 표기", d: "체크 안내: 선택 항목." },  // [검토 필요] 파생 문구(소제목만 파생, 내용은 명세 그대로)
      ],
    },

    groups: [

      // 면담 중 눈으로 본 몸의 움직임을 고르는 체크박스. '특이사항없음'과 나머지는 같이 못 고름.
      {
        id: "behavior",
        label: "행동",
        type: "multi",
        exclusiveNormal: true,
        options: [
          {
            id: "none",
            ko: "특이사항없음",
            en: "특이사항없음",
            def: true,
            normal: true,
          },
          {
            id: "stereotype",
            ko: "상동증",
            en: "stereotype",
            guide: "목적 없는 같은 동작·말의 반복(몸 흔들기, 같은 단어 반복).",
            reveal: ["behavior_text"],
          },
          {
            id: "mannerism",
            ko: "매너리즘",
            en: "mannerism",
            guide: "목적 있는 행동을 기묘하고 과장된 방식으로 함(특이한 걸음, 이상한 손짓으로 인사). ↔ 상동증은 목적 없음.",
            reveal: ["behavior_text"],
          },
          {
            id: "overactivity",
            ko: "과활동",
            en: "overactivity",
            // [v2.2] 활동량이 정반대라 같이 기록될 수 없다 (지체는 속도, 활동저조는 양 — 둘은 서로 함께 있을 수 있다)
            conflicts: ["hypoactivity", "retarded"],
            guide: "활동량 증가, 가만히 못 있음.",
            reveal: ["behavior_text"],
          },
          {
            id: "catatonia",
            ko: "긴장증",
            en: "catatonia",
            guide: "굳은 자세 유지·움직임 거의 없음·지시에 무반응, 또는 갑작스러운 흥분.",
            reveal: ["behavior_text"],
          },
          {
            id: "negativism",
            ko: "거부증",
            en: "negativism",
            guide: "지시·요청에 이유 없이 반대로 행동하거나 거부.",
            reveal: ["behavior_text"],
          },
          {
            id: "echopraxia",
            ko: "동작모방",
            en: "echopraxia",
            guide: "면담자 동작을 따라 함.",
            reveal: ["behavior_text"],
          },
          {
            id: "retarded",
            ko: "지체",
            en: "retarded",
            guide: "움직임·반응·말이 전반적으로 느려짐(속도). ↔ hypoactivity는 양이 적음.",
            reveal: ["behavior_text"],
          },
          {
            id: "hypoactivity",
            ko: "활동저조",
            en: "hypoactivity",
            guide: "움직임이 거의 없음(양).",
            reveal: ["behavior_text"],
          },
          {
            id: "compulsion",
            ko: "강박행위",
            en: "compulsion",
            guide: "하지 않으면 불안해서 반복하는 행동(손 씻기, 확인하기).",
            reveal: ["behavior_text"],
          },
          {
            id: "tic",
            ko: "틱",
            en: "tic",
            guide: "갑작스럽고 반복되는 불수의적 움직임·소리(눈 깜빡임, 어깨 들썩임, 헛기침).",
            reveal: ["behavior_text"],
          },
          {
            id: "agitation",
            ko: "안절부절못함",
            en: "agitation",
            // [v2.2] 안절부절못하는 것과 느려짐·움직임 거의 없음은 같이 기록될 수 없다
            conflicts: ["retarded", "hypoactivity"],
            guide: "초조해서 안절부절, 손 비비기, 자리를 못 지킴.",
            reveal: ["behavior_text"],
          },
          {
            id: "automatism",
            ko: "자동증",
            en: "automatism",
            guide: "의식하지 않고 자동으로 나오는 행동(입맛 다시기, 옷 만지작거리기).",
            reveal: ["behavior_text"],
          },
          {
            id: "perseveration",
            ko: "보속증",
            en: "perseveration",
            guide: "질문이 바뀌어도 같은 답·같은 행동을 계속함.",
            reveal: ["behavior_text"],
          },
        ],
      },

      // 이상 행동을 하나라도 고르면 열리는 자유 기술칸(선택). 적으면 한글 용어 대신 이 문장이 쓰임.
      {
        id: "behavior_text",
        // [검토 필요] 명세 5.3 표의 '펼침' 칸에는 이 텍스트 입력의 라벨이 없고 안내 문구("구체적으로 어떤 행동")만 있어,
        //            그 문구를 label 과 placeholder 에 함께 씀. 화면에 다른 라벨을 쓰려면 명세 5.3 에 라벨을 추가해야 함.
        label: "구체적으로 어떤 행동",
        type: "text",
        hidden: true,
        placeholder: "구체적으로 어떤 행동",
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 문장 조립용 틀. {list} 는 고른 항목들, item 은 목록에 들어갈 한 항목의 표기.
    // 명세 5.3 결과 규칙 그대로: "텍스트가 있으면 텍스트를, 없으면 한글 용어로" — 즉 behavior_text 에 입력이 있으면
    // item 대신 그 텍스트를 {list} 에 넣는다(조립기 담당).
    // [검토 필요] 명세 5.3 의 이상 예시 "면담 중 손을 계속 비비며 안절부절못하는 모습(agitation) 관찰됨."은
    //            아래 틀로는 "안절부절못함(Agitation) 관찰됨."이 되어 예시와 글자 단위로 다름
    //            (예시의 en 은 소문자 agitation, 한글도 "~모습"). 텍스트 입력이 없을 때 어떤 표기를 쓸지 명세에 확정 필요.
    //            틀 문자열 자체는 계약 §4.3 에 명시된 값이므로 그대로 둠.
    outputs: {
      observed: "{list} 관찰됨",
      item: "{ko}({en})",
      // 영문 병기 괄호가 붙은 낱말을 쉼표로 이으면 괄호와 쉼표가 뒤엉켜 읽기 어렵다. 가운뎃점으로 잇는다.
      item_sep: "·", // [검토 필요] 파생 문구(나열 기호만 파생) + 계약 목록 외 추가 키
    },

    summary: { normal: "행동상 특이사항 없음" },
    // [v2.0.2] 행동 선택지는 전부 눈으로 보는 것이라 전화·사이버 상담에서는 관찰할 수 없다
    not_observed: {
      phone: "전화 상담으로 행동은 관찰하지 못함", // [검토 필요] 파생 문구
      online: "비대면(사이버) 상담으로 행동은 관찰하지 못함" // [검토 필요] 파생 문구
    },
  },

  /* ===== 4) 언어 (Speech) ===== */
  {
    id: "speech",
    order: 4,
    title_ko: "언어",
    title_en: "Speech",
    mhis: "check",
    required_confirm: false,

    // 화면 오른쪽 ⓘ 가이드. 명세 5.4 "가이드 내용"에서 그대로 옮김.
    guide: {
      definition: "대상자 말의 '내용'이 아니라 '형식'. 얼마나, 얼마나 빨리, 어떤 목소리로 말하는가.",
      criteria: "자발성: 묻지 않아도 스스로 말을 이어가면 자발적. 질문에만 답하고 먼저 말을 꺼내지 않으면 비자발적. 생산성: increase 답이 길고 말이 많음 / decreased 답이 짧고 적음 / poverty 단답, 내용 빈약, 스스로 말을 거의 안 함(decreased보다 심함) / pressure 쏟아내듯 빠르고 많으며 끊기 어려움. 톤: monotonous 억양 없이 평탄 / mumbled 웅얼거려 알아듣기 어려움 / whispered 속삭이듯 작음. 언어장애: dysarthria 발음이 불분명·혀가 꼬임(약 부작용·신경학적 원인 가능) / cluttering 너무 빠르고 불규칙해 말이 뭉개짐 / aphasia 말을 이해하거나 단어를 떠올리지 못함 / stammering 말더듬 / echolalia 면담자 말을 그대로 따라 함.",
      questions: [],
      questions_note: "없음(관찰 항목)",
      examples: [
        "언어는 자발적이고 생산성·속도·음고·톤 정상 범위이며 언어장애 없음.",
        "말수가 적고 느리며 낮고 단조로운 목소리로 답함. 언어장애는 없음.",
      ],
      mistakes: "말의 양·속도·크기를 구분하고, 질문 이해의 어려움이나 청력·언어 차이를 함께 고려함.",
      extra: [
        { t: "패턴 힌트", d: "pressure + rapid + loud → 조증 의심 / decreased + slow + low + monotonous → 우울 의심. 힌트일 뿐 판정이 아님." },
      ],
    },

    groups: [

      // (1) 자발성 — 묻지 않아도 스스로 말을 꺼내는지. 하나만 고름.
      {
        id: "spontaneity",
        label: "(1) 자발성",
        type: "single",
        options: [
          {
            id: "spontaneity", ko: "자발적", en: "spontaneity", def: true, normal: true,
            guide: "묻지 않아도 스스로 말을 이어가면 자발적.",
          },
          {
            id: "nonspontaneous", ko: "비자발적", en: "nonspontaneous",
            guide: "질문에만 답하고 먼저 말을 꺼내지 않으면 비자발적.",
            mid: "스스로 말을 꺼내지 않고", end: "스스로 말을 꺼내지 않음", // [검토 필요] 파생 문구
          },
        ],
      },

      // (2) 언어 생산성 — 말의 양. 하나만 고름.
      {
        id: "productivity",
        label: "(2) 언어 생산성",
        type: "single",
        options: [
          // 명세 표에 ★normal 의 한글 뜻이 없어 화면 라벨(ko)도 영문 그대로 둠 // [검토 필요] 파생 문구
          { id: "normal", ko: "normal", en: "normal", def: true, normal: true },
          {
            id: "increase", ko: "증가", en: "increase",
            guide: "답이 길고 말이 많음.",
            mid: "말수가 많고", end: "말수가 많음", // [검토 필요] 파생 문구
          },
          {
            id: "decreased", ko: "감소", en: "decreased",
            guide: "답이 짧고 적음.",
            mid: "말수가 적고",
            end: "말수가 적음", // [검토 필요] 파생 문구
          },
          {
            id: "poverty", ko: "언어빈곤", en: "poverty of speech",
            guide: "단답, 내용 빈약, 스스로 말을 거의 안 함(decreased보다 심함).",
            mid: "단답에 그쳐 내용이 빈약하고", end: "단답에 그쳐 내용이 빈약함", // [검토 필요] 파생 문구
          },
          {
            id: "pressure", ko: "압박", en: "pressure",
            guide: "쏟아내듯 빠르고 많으며 끊기 어려움.",
            mid: "쏟아내듯 말이 많고", end: "쏟아내듯 말이 많음", // [검토 필요] 파생 문구
          },
        ],
      },

      // (3) 속도 — 말이 빠른지 느린지. 하나만 고름.
      // 명세 5.4 '판단 기준'에 속도(rapid·slow) 용어 설명이 없어 옵션 ⓘ(guide)는 비워 둠.
      {
        id: "rate",
        label: "(3) 속도",
        type: "single",
        options: [
          // 명세 표에 ★normal 의 한글 뜻이 없어 화면 라벨(ko)도 영문 그대로 둠 // [검토 필요] 파생 문구
          { id: "normal", ko: "normal", en: "normal", def: true, normal: true },
          {
            id: "rapid", ko: "빠름", en: "rapid",
            mid: "말이 빠르며", end: "말이 빠름", // [검토 필요] 파생 문구
          },
          {
            id: "slow", ko: "느림", en: "slow",
            mid: "말이 느리며",
            end: "말이 느림", // [검토 필요] 파생 문구
          },
        ],
      },

      // (4) 음의 고저 — 목소리 높낮이. 하나만 고름.
      // 명세 5.4 '판단 기준'에 음고(high·low) 용어 설명이 없어 옵션 ⓘ(guide)는 비워 둠.
      {
        id: "pitch",
        label: "(4) 음의 고저",
        type: "single",
        options: [
          // 명세 표에 ★normal 의 한글 뜻이 없어 화면 라벨(ko)도 영문 그대로 둠 // [검토 필요] 파생 문구
          { id: "normal", ko: "normal", en: "normal", def: true, normal: true },
          {
            id: "high", ko: "높음", en: "high",
            mid: "높고", end: "목소리가 높음", // [검토 필요] 파생 문구
          },
          {
            id: "low", ko: "낮음", en: "low",
            mid: "낮고",
            end: "목소리가 낮음", // [검토 필요] 파생 문구
          },
        ],
      },

      // (5) 톤 — 목소리 크기·억양. 하나만 고름.
      {
        id: "tone",
        label: "(5) 톤",
        type: "single",
        options: [
          // 명세 표에 ★normally 의 한글 뜻이 없어 화면 라벨(ko)도 영문 그대로 둠 // [검토 필요] 파생 문구
          { id: "normally", ko: "normally", en: "normally", def: true, normal: true },
          {
            // 명세 5.4 '판단 기준'의 톤 설명에 loud 는 없어 옵션 ⓘ(guide)는 비워 둠.
            id: "loud", ko: "큰", en: "loud",
            mid: "큰 목소리로 답함", end: "큰 목소리로 답함", // [검토 필요] 파생 문구
          },
          {
            id: "whispered", ko: "속삭임", en: "whispered",
            guide: "속삭이듯 작음.",
            mid: "속삭이듯 작은 목소리로 답함", end: "속삭이듯 작은 목소리로 답함", // [검토 필요] 파생 문구
          },
          {
            id: "monotonous", ko: "단조로움", en: "monotonous",
            guide: "억양 없이 평탄.",
            mid: "단조로운 목소리로 답함", end: "단조로운 목소리로 답함",
          },
          {
            id: "mumbled", ko: "웅얼거림", en: "mumbled",
            guide: "웅얼거려 알아듣기 어려움.",
            mid: "웅얼거리는 목소리로 답함", end: "웅얼거리는 목소리로 답함", // [검토 필요] 파생 문구
          },
        ],
      },

      // (6) 언어장애 — 여러 개 고를 수 있음. '없음'을 고르면 나머지가 풀리고, 나머지를 고르면 '없음'이 풀림.
      {
        id: "disorder",
        label: "(6) 언어장애",
        type: "multi",
        exclusiveNormal: true,
        options: [
          { id: "none", ko: "없음", en: "없음", def: true, normal: true },
          {
            id: "dysarthria", ko: "구음장애", en: "dysarthria",
            guide: "발음이 불분명·혀가 꼬임(약 부작용·신경학적 원인 가능).",
          },
          {
            id: "cluttering", ko: "속화증", en: "cluttering",
            guide: "너무 빠르고 불규칙해 말이 뭉개짐.",
          },
          {
            id: "aphasia", ko: "실어증", en: "aphasia",
            guide: "말을 이해하거나 단어를 떠올리지 못함.",
          },
          {
            id: "stammering", ko: "말더듬", en: "stammering",
            guide: "말더듬.",
          },
          {
            id: "echolalia", ko: "반향언어", en: "echolalia",
            guide: "면담자 말을 그대로 따라 함.",
          },
        ],
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 결과 문장 고정 문구.
    outputs: {
      disorder_none: "언어장애는 없음",
      disorder_some: "언어장애로 {list}{이가} 관찰됨", // [검토 필요] 파생 문구
    },

    // 6.3 요약문에서 전부 기본값(정상)일 때 쓰는 문장.
    summary: { normal: "언어는 자발적이고 생산성·속도·음고·톤 정상 범위이며 언어장애 없음" },
  },

  /* ===== 5) 기분 (Mood) ===== */
  {
    id: "mood",
    order: 5,
    title_ko: "기분",
    title_en: "Mood",
    mhis: "check",
    required_confirm: true,

    // 화면 우측 가이드 패널에 뜨는 설명(명세 5.5 "가이드 내용" 그대로).
    guide: {
      definition: "mood = 대상자가 스스로 말하는 기분(주관적·지속적). affect = 면담자가 본 정서 표현(표정·목소리·몸짓). 둘은 다를 수 있고, 다르면 둘 다 기록.",
      criteria: "affect 판단 축: 범위(다양한 표정이 나오나), 강도, 안정성(급변하나), 적절성(말 내용과 맞나).",
      questions: [
        "요즘 기분이 어떠세요?",
        "10점이 가장 좋은 상태라면 요즘은 몇 점쯤이세요?",
        "하루 중에 기분이 달라지는 때가 있나요?",
        "짜증이나 화가 나는 일이 많으세요?",
      ],
      examples: [
        "기분은 안정적이라고 보고하며 정서 표현 적절함.",
        "기분을 묻자 '요즘 아무 의욕이 없어요'라며 우울하고 불안하다고 보고함(10점 만점에 3점). 정서 표현은 내용에 적절하나 둔마되어 있음.",
      ],
      mistakes: "대상자가 \"괜찮아요\"라고 해서 euthymia로 체크하고 끝냄. 울먹임·한숨·침울한 표정이 보였으면 affect에 기록.",
      extra: [
        { t: "MHIS 구조", d: "(1) mood 체크박스 11개(복수) (2) Affect 라디오(appropriate/inappropriate) + 체크박스 6개(복수). 필수 확인 섹션." },
        { t: "euthymia 배타", d: "euthymia와 다른 mood는 동시 선택 불가(euthymia를 고르면 나머지 해제)." },
        { t: "정도 순서", d: "restricted / blunted / flat은 정도 차이이므로 하나만 선택 가능." },
        { t: "appropriate / inappropriate", d: "appropriate: 슬픈 얘기에 슬픈 표정. inappropriate: 슬픈 얘기를 하며 웃음." },
        { t: "체크 안내 예", d: "(1) depressed, anxious (2) appropriate / blunted" },
      ],
    },

    groups: [

      // (1) 대상자가 스스로 말한 기분. euthymia 를 고르면 나머지는 해제됨(복수 선택).
      {
        id: "mood",
        label: "(1) mood — 대상자가 말한 기분",
        type: "multi",
        exclusiveNormal: true,
        guide: "euthymia와 다른 mood는 동시 선택 불가(euthymia를 고르면 나머지 해제).",
        options: [
          { id: "euthymia", ko: "안정", en: "euthymia", def: true, normal: true, guide: "정상 범위의 안정된 기분",
            end: "안정적이라고 보고함" },   // [검토 필요] 파생 문구
          { id: "anxious", ko: "걱정하는", en: "anxious", guide: "걱정·불안", reveal: ["mood_text"],
            mid: "불안하고", end: "불안하다고 보고함" },   // [검토 필요] 파생 문구
          { id: "depressed", ko: "우울한", en: "depressed", guide: "지속적이고 전반적인 기분 저하", reveal: ["mood_text"],
            mid: "우울하고", end: "우울하다고 보고함" },   // [검토 필요] 파생 문구
          { id: "elated", ko: "의기양양", en: "elated", guide: "들뜨고 기쁨", reveal: ["mood_text"],
            mid: "들뜨고", end: "들떠 있다고 보고함" },   // [검토 필요] 파생 문구
          { id: "despaired", ko: "절망적인", en: "despaired", guide: "희망이 없다고 느낌", reveal: ["mood_text"],
            mid: "절망적이고", end: "절망적이라고 보고함" },   // [검토 필요] 파생 문구
          { id: "angry", ko: "화", en: "angry", guide: "화", reveal: ["mood_text"],
            mid: "화가 나고", end: "화가 난다고 보고함" },   // [검토 필요] 파생 문구
          { id: "euphoric", ko: "다행감", en: "euphoric", guide: "상황에 맞지 않는 과도한 행복감·자신감", reveal: ["mood_text"],
            mid: "지나치게 행복하고", end: "지나치게 행복하다고 보고함" },   // [검토 필요] 파생 문구
          { id: "ecstasy", ko: "황홀감", en: "ecstasy", guide: "극도의 황홀·도취 (elated < euphoric < ecstasy)", reveal: ["mood_text"],
            mid: "황홀하고", end: "황홀하다고 보고함" },   // [검토 필요] 파생 문구
          { id: "dysphoric", ko: "불쾌감", en: "dysphoric", guide: "짜증·불편·불행이 섞인 불쾌한 상태", reveal: ["mood_text"],
            mid: "불쾌하고", end: "불쾌하다고 보고함" },   // [검토 필요] 파생 문구
          { id: "sad", ko: "슬픈", en: "sad", guide: "상황에 맞는 슬픔(↔ depressed는 전반적·지속적)", reveal: ["mood_text"],
            mid: "슬프고", end: "슬프다고 보고함" },   // [검토 필요] 파생 문구
          { id: "tense", ko: "긴장한", en: "tense", guide: "긴장", reveal: ["mood_text"],
            mid: "긴장되고", end: "긴장된다고 보고함" },   // [검토 필요] 파생 문구
        ],
      },

      // euthymia 외의 기분을 고르면 나타남. 대상자가 말한 그대로 옮겨 적는 칸(선택).
      {
        id: "mood_text",
        label: "대상자 표현 그대로",
        type: "text",
        hidden: true,
        placeholder: "대상자 표현 그대로 (예: 요즘 아무 의욕이 없어요)",
      },

      // 대상자가 직접 말한 0~10점(선택). 명세 5.5 표의 '펼침'이 '—' 이므로 항상 보임.
      {
        id: "mood_score",
        label: "(1)-2 기분 점수 — 대상자가 말한 점수 (선택)",
        type: "scale",
        min: 0,
        max: 10,
      },

      // (2)-1 말 내용과 표정이 맞는지(정서 표현의 적절성).
      {
        id: "affect_fit",
        label: "(2)-1 Affect 적절성",
        type: "single",
        guide: "appropriate: 슬픈 얘기에 슬픈 표정. inappropriate: 슬픈 얘기를 하며 웃음.",
        options: [
          { id: "appropriate", ko: "적절", en: "appropriate", def: true, normal: true, guide: "슬픈 얘기에 슬픈 표정.",
            mid: "정서 표현은 내용에 적절하나", end: "정서 표현 적절함" },
          { id: "inappropriate", ko: "부적절", en: "inappropriate", guide: "슬픈 얘기를 하며 웃음.", reveal: ["affect_fit_text"],
            mid: "정서 표현이 내용과 맞지 않고", end: "정서 표현이 내용과 맞지 않음" },   // [검토 필요] 파생 문구
        ],
      },

      // inappropriate 를 고르면 나타남. 어떤 이야기에 어떤 표정이었는지 적는 칸.
      {
        id: "affect_fit_text",
        label: "어떤 내용에 어떤 표정",
        type: "text",
        hidden: true,
        placeholder: "어떤 내용에 어떤 표정",
      },

      // (2)-2 관찰된 정서 표현의 양상. restricted / blunted / flat 은 정도 차이라 하나만 고를 수 있음.
      {
        id: "affect_type",
        label: "(2)-2 Affect 양상",
        type: "multi",
        exclusiveNormal: true,
        onlyOneOf: ["restricted", "blunted", "flat"],
        guide: "restricted 범위·강도가 약간 줄어듦 → blunted 상당히 줄어 표현이 거의 없음 → flat 표정 변화가 전혀 없음. 정도 순서, 하나만.",
        options: [
          { id: "none", ko: "해당 없음", en: "", def: true, normal: true },
          { id: "blunted", ko: "둔마", en: "blunted", guide: "상당히 줄어 표현이 거의 없음",
            mid: "둔마되어 있고", end: "둔마되어 있음" },
          { id: "flat", ko: "무미건조", en: "flat", guide: "표정 변화가 전혀 없음",
            mid: "표정 변화가 전혀 없고", end: "표정 변화가 전혀 없음" },
          { id: "labile", ko: "불안정", en: "labile", guide: "짧은 시간에 급격히 변함(울다가 웃음)",
            mid: "정서가 불안정하게 급변하고", end: "정서가 불안정하게 급변함" },   // [검토 필요] 파생 문구
          { id: "restricted", ko: "제한적", en: "restricted", guide: "범위·강도가 약간 줄어듦",
            mid: "표현 범위가 제한적이고", end: "표현 범위가 제한적임" },   // [검토 필요] 파생 문구
          { id: "fear", ko: "두려움", en: "fear", guide: "두려워하는 표정·행동 관찰",
            mid: "두려워하는 표정이 관찰되고", end: "두려워하는 표정이 관찰됨" },   // [검토 필요] 파생 문구
          { id: "agitation", ko: "초조", en: "agitation", guide: "초조·안절부절 관찰",
            mid: "초조해하는 모습이 관찰되고", end: "초조해하는 모습이 관찰됨" },   // [검토 필요] 파생 문구
        ],
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 요약문 조립용 고정 문구
    outputs: {
      mood_quote: "기분을 묻자 '{text}'라며",
      mood_lead: "기분은",
      score: "(10점 만점에 {n}점)",
    },

    // 전부 기본값(euthymia + appropriate + 해당 없음)일 때 6.3 요약문에 들어갈 문장.
    summary: { normal: "기분은 안정적이라고 보고하며 정서 표현 적절함" },
  },

  /* ===== 6) 지각 (Perception) ===== */
  {
    id: "perception",
    order: 6,
    title_ko: "지각",
    title_en: "Perception",
    mhis: "mixed",
    required_confirm: false,

    // 섹션 ⓘ 가이드 — 명세 5.6 '가이드 내용'에서 그대로 옮김
    guide: {
      definition: "환각 = 실제 자극이 없는데 실제처럼 보이거나 들림. 착각 = 실제 자극(옷걸이)을 다른 것(사람)으로 잘못 봄 → '기타 지각 이상'에.",
      criteria: "명령 환청(특히 자·타해 지시)은 위험 신호 → 사고 섹션의 자타해사고와 연결해 반드시 기록. 면담 중 허공을 보거나 혼잣말을 하면 대상자 말과 별개로 \"환각에 반응하는 듯한 행동 관찰됨\"을 기록.",
      questions: [
        "다른 사람에게는 안 들리는 소리나 목소리가 들린 적 있으세요?",
        "뭐라고 하나요? 무언가를 하라고 시키나요?",
        "얼마나 자주, 주로 언제 들리세요?",
        "언제부터 그랬어요?",
        "실제 소리 같으세요, 아니면 증상이라고 생각하세요?",
        "그 소리 때문에 하게 되는 행동이 있나요?",
        "환시: 다른 사람은 못 보는 것이 보인 적 있으세요?",
        "환촉·환후: 몸에 뭔가 기어다니는 느낌이나, 남들은 못 맡는 냄새가 난 적 있으세요?",
      ],
      examples: [
        "환청, 환시 등 환각 부인함. 면담 중 환각에 반응하는 행동 관찰되지 않음.",
        "환청 있음. 2~3명이 자신을 욕하는 목소리가 주 3회 이상, 주로 밤에 혼자 있을 때 들린다고 보고함. 약 2개월 전부터 시작되었으며, 대상자는 실제 소리라고 확신하고 있음. 목소리에 대꾸하며 혼잣말하는 행동이 관찰됨. 명령 환청은 부인함. 환시·환후·환촉·환미는 부인함.",
      ],
      mistakes: "유형만 체크하고 서술 칸을 비움. 내용·빈도·반응이 없으면 다음 평가와 비교할 수 없음.",
      extra: [
        { t: "있음 틀", d: "[유형] 있음. [내용]이(가) [빈도], 주로 [상황]에 들린다고 보고함. [시작 시기]부터 시작되었으며, 대상자는 [반응]. [행동 영향]. 명령 환청은 [부인함 / 있음: 내용]. [나머지 유형]은 부인함." },
        { t: "기타 지각 이상", d: "기타 지각 이상이 있으면 마지막에 \"착각: [텍스트]\" 형태로 덧붙임." },
      ],
    },

    groups: [

      // 환각 유형 — 여러 개 고를 수 있고, 유형을 고르면 그 유형의 세부 틀이 아래에 열림
      {
        id: "hallucination",
        label: "환각",
        type: "multi",
        exclusiveNormal: true,
        guide: "환각 = 실제 자극이 없는데 실제처럼 보이거나 들림.",
        options: [
          { id: "none", ko: "없음", en: "없음", def: true, normal: true },
          {
            id: "auditory", ko: "환청", en: "auditory hallucination", frame: "hallu", // [검토 필요] 명세 5.6 표는 "auditory", 부록 B-2 출력은 "auditory hallucination" — 부록 B-2 와 글자 단위로 맞추려고 후자를 씀
            short: "환청", // [검토 필요] 파생 문구
            percept: "소리", // [검토 필요] 파생 문구
            verb: "들린다", // [검토 필요] 파생 문구 — 유형별 서술 동사(환청은 들린다, 환시는 보인다 …)
          },
          {
            id: "visual", ko: "환시", en: "visual hallucination", frame: "hallu", // [검토 필요] 위와 같음
            short: "환시", // [검토 필요] 파생 문구
            percept: "모습", // [검토 필요] 파생 문구
            verb: "보인다", // [검토 필요] 파생 문구 — 유형별 서술 동사(환청은 들린다, 환시는 보인다 …)
          },
          {
            id: "olfactory", ko: "환후", en: "olfactory hallucination", frame: "hallu", // [검토 필요] 위와 같음
            short: "환후", // [검토 필요] 파생 문구
            percept: "냄새", // [검토 필요] 파생 문구
            verb: "난다", // [검토 필요] 파생 문구 — 유형별 서술 동사(환청은 들린다, 환시는 보인다 …)
          },
          {
            id: "tactile", ko: "환촉", en: "tactile hallucination", frame: "hallu", // [검토 필요] 위와 같음
            short: "환촉", // [검토 필요] 파생 문구
            percept: "감각", // [검토 필요] 파생 문구
            verb: "느껴진다", // [검토 필요] 파생 문구 — 유형별 서술 동사(환청은 들린다, 환시는 보인다 …)
          },
          {
            id: "gustatory", ko: "환미", en: "gustatory hallucination", frame: "hallu", // [검토 필요] 위와 같음
            short: "환미", // [검토 필요] 파생 문구
            percept: "맛", // [검토 필요] 파생 문구
            verb: "느껴진다", // [검토 필요] 파생 문구 — 유형별 서술 동사(환청은 들린다, 환시는 보인다 …)
          },
        ],
      },

      // 환각이 아닌 지각 이상(착각·이인증 등) — 하나만 고름
      {
        id: "other_perception",
        label: "기타 지각 이상",
        type: "single",
        guide: "착각 = 실제 자극(옷걸이)을 다른 것(사람)으로 잘못 봄 → '기타 지각 이상'에.",
        options: [
          { id: "none", ko: "없음", en: "", def: true, normal: true },
          { id: "illusion", ko: "착각(illusion)", en: "", noun: "착각", reveal: ["other_perception_text"] },
          { id: "depersonal", ko: "이인증·비현실감", en: "", noun: "이인증·비현실감", reveal: ["other_perception_text"] },
          {
            id: "other", ko: "기타", en: "", reveal: ["other_perception_text"],
            noun: "기타 지각 이상", // [검토 필요] 파생 문구
          },
        ],
      },

      // 위에서 '없음'이 아닌 것을 고르면 나타나는 서술 칸
      {
        id: "other_perception_text",
        chips: ["면담 중 허공을 응시함", "혼잣말을 함", "특정 주제에서 갑자기 경계함"],
        label: "기타 지각 이상 내용", // [검토 필요] 파생 문구
        type: "text",
        hidden: true,
        placeholder: "어떤 지각 이상인지", // [검토 필요] 파생 문구
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 환각 유형을 고르면 그 유형마다 하나씩 열리는 세부 틀 (명세 5.6 '세부 틀')
    frames: {
      hallu: {
        label: "환각 세부",
        repeatable: false,
        groups: [

          // 대상자가 말한 환각 내용을 그대로 적음
          {
            id: "content",
            label: "내용",
            type: "text",
            placeholder: "대상자 표현 그대로 (예: 2~3명이 나를 욕하는 소리)",
          },

          // 명령 환청 여부 — 환청을 고른 경우에만 나타남
          {
            id: "command",
            label: "명령 환청 여부 (환청만)",
            type: "single",
            showIfFrameOption: ["auditory"],
            guide: "명령 환청(특히 자·타해 지시)은 위험 신호 → 사고 섹션의 자타해사고와 연결해 반드시 기록.",
            // [v1.6] 기본값 없음 — 묻지 않은 명령 환청이 '부인함'으로 기록되면 안 됨
            options: [
              { id: "no", ko: "없음", normal: true },
              { id: "yes", ko: "있음", reveal: ["command_text"] },
            ],
          },

          // 명령 환청이 있을 때만 나타나는 서술 칸
          {
            id: "command_text",
            label: "명령 내용", // [검토 필요] 파생 문구
            type: "text",
            hidden: true,
            placeholder: "무엇을 하라고 하나",
          },

          // 얼마나 자주 나타나는지
          {
            id: "freq",
            label: "빈도",
            type: "single",
            options: [
              { id: "sometimes", ko: "가끔", def: true, noun: "가끔" },
              { id: "w12", ko: "주 1~2회", noun: "주 1~2회" },
              { id: "w3", ko: "주 3회 이상", noun: "주 3회 이상" },
              { id: "daily", ko: "매일", noun: "매일" },
              { id: "almost", ko: "거의 항상", noun: "거의 항상" },
            ],
          },

          // 주로 언제·어떤 상황에서 나타나는지 (여러 개 선택)
          {
            id: "context",
            label: "발생 상황",
            type: "multi",
            options: [
              {
                id: "night", ko: "밤·잠들 무렵",
                noun: "밤에", // [검토 필요] 파생 문구
              },
              { id: "alone", ko: "혼자 있을 때", noun: "혼자 있을 때" },
              {
                id: "stress", ko: "스트레스 받을 때",
                noun: "스트레스를 받을 때", // [검토 필요] 파생 문구
              },
              { id: "nonspecific", ko: "특정 없음", noun: "" },
            ],
          },

          // 언제부터 시작되었는지
          {
            id: "onset",
            label: "시작 시기",
            type: "text",
            placeholder: "예: 약 2개월 전",
          },

          // 대상자가 이 경험을 어떻게 받아들이는지
          {
            id: "reaction",
            label: "대상자 반응",
            type: "single",
            options: [
              // [v1.6] 기본값 없음 — 묻지 않은 상태에서 병식이 가장 나쁜 쪽으로 기록되면 안 됨
              { id: "real", ko: "실제라고 믿음", end: "실제 {percept}{라고} 확신하고 있음" },
              {
                id: "illness", ko: "병 때문이라고 앎",
                end: "병으로 인한 증상이라고 인식하고 있음", // [검토 필요] 파생 문구
              },
              {
                id: "ambivalent", ko: "반신반의",
                end: "실제인지 증상인지 확신하지 못함", // [검토 필요] 파생 문구
              },
              {
                id: "ignorable", ko: "무시할 수 있음",
                end: "무시할 수 있다고 함", // [검토 필요] 파생 문구
              },
            ],
          },

          // 그 때문에 하게 되는 행동 (여러 개 선택, '없음'과는 함께 못 고름)
          // 여러 개를 고르면 마지막 것만 end, 앞의 것은 mid 로 이어 붙는다.
          // mid 는 명세에 없어 end 에서 만든 연결형이다(끝의 '관찰됨'은 마지막 조각이 받는다).
          {
            id: "impact",
            label: "행동 영향",
            type: "multi",
            exclusiveNormal: true,
            options: [
              { id: "none", ko: "없음", def: true, normal: true },
              {
                id: "cover", ko: "귀를 막거나 소리 지름",
                mid: "귀를 막거나 소리를 지르고,", // [검토 필요] 파생 문구
                end: "귀를 막거나 소리를 지르는 행동이 관찰됨", // [검토 필요] 파생 문구
              },
              {
                id: "talk", ko: "혼잣말·대꾸",
                mid: "목소리에 대꾸하며 혼잣말하고,", // [검토 필요] 파생 문구
                end: "목소리에 대꾸하며 혼잣말하는 행동이 관찰됨",
              },
              {
                id: "obey", ko: "지시를 따름",
                mid: "지시를 따르고,", // [검토 필요] 파생 문구
                end: "지시를 따르는 행동이 관찰됨", // [검토 필요] 파생 문구
              },
              {
                id: "avoid", ko: "외출 회피",
                mid: "외출을 회피하고,", // [검토 필요] 파생 문구
                end: "외출을 회피함", // [검토 필요] 파생 문구
              },
              { id: "other", ko: "기타", reveal: ["impact_text"], end: "{text}" },
            ],
          },

          // 행동 영향에서 '기타'를 고르면 나타나는 서술 칸
          {
            id: "impact_text",
            label: "기타 행동 영향", // [검토 필요] 파생 문구
            type: "text",
            hidden: true,
            placeholder: "어떤 행동인지", // [검토 필요] 파생 문구
          },

        ],
      },
    },

    // 결과 패널 문장 틀 — 키 이름은 조립기가 직접 참조하므로 바꾸지 말 것
    outputs: {
      none: "환청, 환시 등 환각 부인함. 면담 중 환각에 반응하는 행동 관찰되지 않음",
      // [v2.0.2] 전화·사이버 상담에서는 "반응하는 행동"을 볼 수 없으므로 관찰 주장을 뺀다
      none_notobs: "환청, 환시 등 환각 부인함", // [검토 필요] 파생 문구
      lead: "{type} 있음",
      detail: "{content}{이가} {freq}, 주로 {context} {verb}고 보고함", // {verb} 는 유형별 서술 동사
      detail_nocontext: "{content}{이가} {freq} {verb}고 보고함",
      // [v2.0.2] 대상자가 들은/본 것을 문장으로 적었을 때('~다'로 끝날 때). 사고 섹션의 _da 틀과 같은 방식
      // [v2.2] 어순은 명사구 틀(detail)과 같아야 한다 — 같은 사실인데 직원이 어떻게 적었는지에 따라
      //        "주 3회 이상, 주로 밤에" 와 "주로 밤에 주 3회 이상" 으로 갈리면 안 된다. 부록 B-2 원문 어순을 따른다.
      //        발생 상황이 셋 이상이면 상황끼리 쉼표로 끊어 준다(조립기가 이어 붙인다).
      detail_da: "'{content}'는 {percept}{이가} {freq}, 주로 {context} {verb}고 보고함", // [검토 필요] 파생 문구
      detail_nocontext_da: "'{content}'는 {percept}{이가} {freq} {verb}고 보고함", // [검토 필요] 파생 문구
      onset: "{onset}부터 시작되었으며, 대상자는 {reaction}",
      onset_only: "대상자는 {reaction}", // [검토 필요] 파생 문구
      command_no: "명령 환청은 부인함",
      // [v1.6] 아래 셋은 적대적 검증에서 확인된 결함을 막기 위해 새로 넣은 문구
      onset_alone: "{onset}부터 시작되었음", // [검토 필요] 파생 문구 — 대상자 반응을 고르지 않았을 때
      command_unknown: "{missing} 명령 환청 여부는 이번 면담에서 확인하지 못함", // [검토 필요] 파생 문구
      alert_command: "자·타해 지시 명령 환청 — 7) 사고의 자살·타해 사고를 반드시 직접 확인하세요", // [검토 필요] 파생 문구
      command_yes: "'{text}'{라는} 명령 환청이 있다고 보고함", // [검토 필요] 파생 문구
      // [v2.1] 명령 환청을 '있음'으로 고르고 내용 칸을 비웠을 때 — 빈 따옴표('')가 기록으로 나가면 안 된다
      command_yes_notext: "명령 환청이 있다고 보고하나 그 내용은 {missing}", // [검토 필요] 파생 문구
      // [v2.1] 행동 영향에서 '기타'만 고르고 칸을 비웠을 때 — 문장이 통째로 사라지지 않게 남긴다
      impact_other_missing: "그 밖의 행동 영향은 {missing}", // [검토 필요] 파생 문구
      // 조사는 앞말 받침에 맞춰 자동으로 고른다(7장 규칙). 명세 362줄 틀 "[나머지 유형]은 부인함" 과
      // 363줄 예시 "…환미는 부인함" 이 서로 달랐는데, {은는} 을 쓰면 둘 다 맞는다.
      // ("{list}는" 으로 고정하면 "환시·환후·환촉는 부인함" 처럼 틀린다. 되돌리지 말 것.)
      deny_rest: "{list}{은는} 부인함",
      other_perception: "{label}: {text}",
      other_perception_notext: "{label} 있음",
    },

    // 요약문(상담일지용)에 쓰는 정상 문장
    summary: { normal: "환각 부인함" },
  },

  /* ===== 7) 사고 (Thought) ===== */
  {
    id: "thought",
    order: 7,
    title_ko: "사고",
    title_en: "Thought",
    mhis: "mixed",
    required_confirm: true,

    guide: {
      definition: "(1) 형태·과정 = 생각이 이어지는 방식. (3) 망상 = 사실이 아닌데 설득으로 바뀌지 않는 확고한 믿음. 문화·종교적으로 통용되는 믿음은 제외.",
      criteria: "대상자 말의 흐름으로 판단. 정상이면 appropriate + logical·coherence 체크. 구분: circumstantiality vs tangentiality = 결국 답했는가. loosening vs flight of idea = 속도와 연결 흔적.",
      questions: [
        "누군가 해치려 하거나 감시한다고 느끼세요?",
        "TV나 인터넷이 나를 두고 말한다고 느낀 적 있으세요?",
        "남들에게 없는 특별한 능력이 있으세요?",
        "누가 내 생각을 읽거나 조종한다고 느끼세요?",
        "얼마나 확신하세요? 다른 설명이 가능할까요?",
        "요즘 죽고 싶다는 생각이 드신 적 있으세요?",
        "얼마나 자주요?",
        "어떻게 할지 구체적으로 생각해 보셨나요?",
        "실제로 할 수 있는 방법이 주변에 있나요?",
        "예전에 시도한 적 있으세요?",
        "그 생각을 멈추게 하는 건 뭔가요?",
        "누군가를 해치고 싶은 생각은요?",
      ],
      questions_note: "앞 5개는 (3) 망상 확인 질문, 뒤 7개는 (4) 자타해사고 확인 질문(직접 묻고, 돌려 묻지 않기).", // [검토 필요] 파생 문구
      examples: [
        "피해망상 있음. '윗집 사람들이 나를 감시하고 도청한다'고 확고하게 믿고 있음. 약 6개월 전부터 시작되었으며, 이로 인해 경찰에 2회 신고하고 창문을 가리고 지냄.",
        "자살사고 있음. '차라리 없어지는 게 낫겠다'는 생각이 거의 매일 든다고 보고함. 구체적 계획과 수단 접근 가능성은 부인하나, 의도는 중간 수준으로 표현함. 과거 시도력 1회(2024년). 보호요인으로 어머니와 반려견을 언급함. 타해사고 부인함.",
        "관계사고: TV 뉴스가 자신을 두고 말한다고 느낌.",
      ],
      mistakes: "intact를 '있음'으로 오해 / 망상 내용을 요약해 씀(대상자 표현을 따옴표로 그대로) / 자살사고 '없음'을 묻지 않고 체크.",
      extra: [
        { t: "라벨 주의", d: "MHIS에서 intact = 해당 없음(정상), impaired = 있음. 도구 화면에는 \"없음 / 있음\"으로 표시하고, 결과의 체크 안내에 MHIS 라벨을 병기함." },
        { t: "망상 유형과 MHIS 체크", d: "망상 '있음'이면 (2)는 자동으로 '유'가 되고, 유형에 맞는 MHIS 체크를 안내함: 피해 → Persecutory, 관계 → Idea of reference, 과대 → Grandiose, 애정·색정 → Erotic. 그 외 유형은 \"해당 체크 없음, 서술 칸에만 기록\"으로 안내." },
        { t: "자살사고 있음일 때", d: "자살사고 '있음'이면 결과 카드 상단에 붉은 띠: \"자살사고 있음 — 센터 위기평가 절차를 확인하세요\". 판정이 아니라 절차 상기용." },
        { t: "자타해사고 기록", d: "있음이면 센터 위기평가 도구로 이어가고, 이 칸에는 사실만 기록." },
      ],
    },

    groups: [

      // 생각이 이어지는 방식이 적절한지 하나 고르는 칸. 부적절을 고르면 아래 이상 항목이 열림.
      {
        id: "form",
        label: "(1) 사고 형태·과정",
        type: "single",
        guide: "생각이 이어지는 방식. 대상자 말의 흐름으로 판단. 정상이면 appropriate + logical·coherence 체크.",
        options: [
          { id: "appropriate", ko: "적절", en: "appropriate", def: true, normal: true },
          { id: "inappropriate", ko: "부적절", en: "inappropriate", reveal: ["form_items"] },
        ],
      },

      // 사고 형태가 부적절할 때만 나타나는 세부 항목(여러 개 고를 수 있음).
      {
        id: "form_items",
        label: "(1)-2 이상 항목",
        type: "multi",
        hidden: true,
        options: [
          { id: "illogical", ko: "비논리적", en: "illogical", guide: "결론이 앞뒤와 안 맞음", reveal: ["form_text"] },
          { id: "loosening", ko: "연상이완", en: "loosening of association", guide: "관련 없는 주제로 옮겨가고 연결이 안 됨", reveal: ["form_text"] },
          { id: "flight", ko: "사고비약", en: "flight of idea", guide: "빠르게 주제가 바뀌지만 약하게라도 연결됨(주로 조증, pressure와 함께)", reveal: ["form_text"] },
          { id: "incoherent", ko: "지리멸렬", en: "incoherent", guide: "문장 자체가 이해 불가", reveal: ["form_text"] },
          { id: "blocking", ko: "사고차단", en: "blocking", guide: "말하다 갑자기 멈추고 이어가지 못함", reveal: ["form_text"] },
          { id: "retardation", ko: "사고지연", en: "retardation", guide: "생각 진행이 느려 답이 늦음", reveal: ["form_text"] },
          { id: "circumstantiality", ko: "우회적", en: "circumstantiality", guide: "곁가지가 많지만 결국 답에 도달", reveal: ["form_text"] },
          { id: "tangentiality", ko: "사고의 이탈", en: "tangentiality", guide: "곁가지로 빠져 답에 도달 못 함", reveal: ["form_text"] },
        ],
      },

      // 이상 항목을 고르면 나타나는 자유 입력 칸. 대상자가 실제로 한 말을 적음.
      // [검토 필요] 이상 항목 8개가 모두 이 한 칸을 공유함(계약대로). 항목별로 따로 적을 수 없음 — 의도된 설계인지 확인 필요.
      {
        id: "form_text",
        label: "예시 발화",
        type: "text",
        hidden: true,
        placeholder: "예시 발화",
      },

      // 사고 내용에 이상이 있는지 유·무로 고르는 칸. '유'를 고르면 내용 항목이 열림.
      {
        id: "content_abn",
        label: "(2) 사고 내용 이상",
        type: "single",
        options: [
          { id: "no", ko: "무", en: "", def: true, normal: true },
          { id: "yes", ko: "유", en: "", reveal: ["content_items"] },
        ],
      },

      // 사고 내용 이상이 '유'일 때 나타나는 항목들(여러 개 고를 수 있음). 고른 항목마다 아래에 내용 칸이 열림.
      {
        id: "content_items",
        label: "(2)-2 내용 항목",
        type: "multi",
        hidden: true,
        options: [
          { id: "autistic", ko: "자폐적", en: "Autistic", guide: "현실과 동떨어진 자기만의 세계", reveal: ["ci_autistic_text"] },
          { id: "ambivalence", ko: "양가적", en: "Ambivalence", guide: "상반된 감정·생각이 동시에", reveal: ["ci_ambivalence_text"] },
          { id: "magical", ko: "마술적", en: "Magical", guide: "생각이 현실을 바꾼다고 믿음", reveal: ["ci_magical_text"] },
          { id: "obsession", ko: "강박", en: "Obsession", guide: "원치 않는데 반복해서 떠오르는 생각", reveal: ["ci_obsession_text"] },
          { id: "hypochondriasis", ko: "건강염려", en: "Hypochondriasis", guide: "병에 대한 지나친 걱정", reveal: ["ci_hypochondriasis_text"] },
          { id: "phobia", ko: "공포", en: "Phobia", guide: "특정 대상·상황에 대한 비합리적 공포", reveal: ["ci_phobia_text"] },
          { id: "reference", ko: "관계사고", en: "Idea of reference", guide: "무관한 일이 자신과 관련 있다고 느낌(확신이 굳으면 관계망상)", reveal: ["ci_reference_text"] },
          { id: "persecutory", ko: "피해", en: "Persecutory", guide: "해를 입고 있다는 믿음", reveal: ["ci_persecutory_text"] },
          { id: "grandiose", ko: "과대", en: "Grandiose", guide: "특별한 능력·지위·사명", reveal: ["ci_grandiose_text"] },
          { id: "erotic", ko: "애정·색정", en: "Erotic", guide: "누군가 자신을 사랑한다는 믿음", reveal: ["ci_erotic_text"] },
        ],
      },

      // 아래 10개는 내용 항목별 자유 입력 칸. 여기 적은 내용은 (5) 기타 서술 칸으로 모임.
      { id: "ci_autistic_text", label: "자폐적", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_ambivalence_text", label: "양가적", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_magical_text", label: "마술적", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_obsession_text", label: "강박", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_hypochondriasis_text", label: "건강염려", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_phobia_text", label: "공포", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_reference_text", label: "관계사고", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_persecutory_text", label: "피해", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_grandiose_text", label: "과대", type: "text", hidden: true, placeholder: "내용" },
      { id: "ci_erotic_text", label: "애정·색정", type: "text", hidden: true, placeholder: "내용" },

      // 망상 유무. '있음'을 고르면 망상 세부 틀이 열리며, [망상 추가]로 여러 개 입력할 수 있음.
      {
        id: "delusion",
        label: "(3) 망상",
        type: "single",
        guide: "망상 = 사실이 아닌데 설득으로 바뀌지 않는 확고한 믿음. 문화·종교적으로 통용되는 믿음은 제외.",
        options: [
          { id: "no", ko: "없음(intact)", en: "", def: true, normal: true },
          { id: "yes", ko: "있음(impaired)", en: "", frame: "delusion", force: { group: "content_abn", option: "yes" } },
        ],
      },

      // 자살·타해 사고 유무. '있음'을 고르면 자타해사고 세부 틀이 열림. 반드시 직접 물어보고 고를 것.
      {
        id: "selfharm",
        label: "(4) 자살·타해 사고",
        type: "single",
        guide: "확인 질문(직접 묻고, 돌려 묻지 않기). 있음이면 센터 위기평가 도구로 이어가고, 이 칸에는 사실만 기록.",
        options: [
          { id: "no", ko: "없음(intact)", en: "", def: true, normal: true },
          { id: "yes", ko: "있음(impaired)", en: "", frame: "selfharm" },
        ],
      },

      // [v2.0] 학대·방임 의심 — 신고 의무가 걸린 상황. 확인된 사실만 고르고, 신고 여부는 센터 절차로 정한다.
      {
        id: "abuse",
        label: "(4)-2 학대·방임 의심 (신고 의무)",
        type: "multi",
        exclusiveNormal: true,
        guide: "아동·노인·장애인 학대와 자기방임이 의심되면 정신건강복지센터 종사자는 신고 의무자입니다. 여기에는 관찰·진술된 사실만 적고, 신고 여부는 팀장 보고 후 센터 절차로 정합니다. 판단이나 추정은 적지 않습니다.", // [검토 필요] 파생 문구
        options: [
          { id: "none", ko: "해당 없음", en: "", def: true, normal: true },
          { id: "child", ko: "아동 학대 의심", en: "", noun: "아동 학대", reveal: ["abuse_text"] }, // [검토 필요] 파생 문구
          { id: "elder", ko: "노인 학대 의심", en: "", noun: "노인 학대", reveal: ["abuse_text"] }, // [검토 필요] 파생 문구
          { id: "disabled", ko: "장애인 학대 의심", en: "", noun: "장애인 학대", reveal: ["abuse_text"] }, // [검토 필요] 파생 문구
          { id: "dv", ko: "가정폭력 피해 의심", en: "", noun: "가정폭력 피해", reveal: ["abuse_text"] }, // [검토 필요] 파생 문구
          { id: "selfneglect", ko: "자기방임 의심", en: "", noun: "자기방임", reveal: ["abuse_text"] }, // [검토 필요] 파생 문구
        ],
      },
      {
        id: "abuse_text",
        label: "무엇을 보고 들었나 (사실만)", // [검토 필요] 파생 문구
        type: "text",
        hidden: true,
        placeholder: "관찰·진술된 사실만 적으세요 (예: 얼굴에 멍이 있고, 남편이 때렸다고 말함)", // [검토 필요] 파생 문구
      },

      // 기타 사고 관련 자유 기술 칸. (2)-2에 적은 텍스트가 자동으로 모이고, 여기에 더 쓸 수 있음.
      {
        id: "etc_text",
        label: "(5) 기타",
        type: "text",
        guide: "(2)-2의 텍스트가 자동으로 모임 + 자유 입력",
        placeholder: "기타 사고 관련 기술",
        chips: [
          "면담 중 허공을 응시함",
          "혼잣말을 함",
          "특정 주제에서 갑자기 경계함",
        ],
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    frames: {

      // 망상 '있음'일 때 열리는 세부 틀. 망상이 여러 개면 [망상 추가]로 틀을 여러 개 만듦.
      delusion: {
        label: "망상",
        repeatable: true,
        groups: [

          // 망상 유형. 앞의 네 유형만 MHIS 체크가 대응되고, 나머지는 서술 칸에만 기록함.
          // [검토 필요] noun 은 계약대로 ko 그대로임. delusion_lead 에 넣으면 other 는 "기타망상 있음"이 되어 어색함 — 조립기에서 별도 처리 필요.
          // [검토 필요] mhis:"" 는 명세의 "해당 체크 없음"을 빈 문자열로 표현한 것. 필드명·빈값 처리는 명세에 없음.
          {
            id: "type",
            label: "유형",
            type: "select",
            guide: "망상 '있음'이면 (2)는 자동으로 '유'가 되고, 유형에 맞는 MHIS 체크를 안내함: 피해 → Persecutory, 관계 → Idea of reference, 과대 → Grandiose, 애정·색정 → Erotic. 그 외 유형은 \"해당 체크 없음, 서술 칸에만 기록\"으로 안내.",
            options: [
              { id: "persecutory", ko: "피해", en: "", mhis: "Persecutory", noun: "피해" },
              { id: "reference", ko: "관계", en: "", mhis: "Idea of reference", noun: "관계" },
              { id: "grandiose", ko: "과대", en: "", mhis: "Grandiose", noun: "과대" },
              { id: "erotic", ko: "애정·색정", en: "", mhis: "Erotic", noun: "애정·색정" },
              { id: "jealous", ko: "질투", en: "", mhis: "", noun: "질투" },
              { id: "somatic", ko: "신체", en: "", mhis: "", noun: "신체" },
              { id: "control", ko: "조종·영향", en: "", mhis: "", noun: "조종·영향" },
              { id: "broadcast", ko: "사고전파·주입", en: "", mhis: "", noun: "사고전파·주입" },
              { id: "religious", ko: "종교", en: "", mhis: "", noun: "종교" },
              { id: "nihilistic", ko: "빈곤·죄책·허무", en: "", mhis: "", noun: "빈곤·죄책·허무" },
              // [v2.1] 확신이 굳지 않을 때도 '기타망상 의심'처럼 붙어 나가지 않게 따로 둠
              { id: "other", ko: "기타", en: "", mhis: "", noun: "기타", lead_override: "기타 유형의 망상 있음", lead_override_unsure: "기타 유형의 망상 의심" }, // [검토 필요] 파생 문구
            ],
          },

          // 망상의 내용. 요약하지 말고 대상자가 한 말 그대로 적음(따옴표로 인용됨).
          {
            id: "content",
            label: "내용",
            type: "text",
            placeholder: "대상자 표현 그대로",
          },

          // 그 믿음을 얼마나 확고하게 붙들고 있는지.
          {
            id: "conviction",
            label: "확신도",
            type: "single",
            options: [
              { id: "firm", ko: "확고함", en: "", def: true, noun: "확고하게" },
              { id: "shaky", ko: "흔들림", en: "", noun: "다소 흔들리는 태도로" }, // [검토 필요] 파생 문구
              { id: "ambivalent", ko: "반신반의", en: "", noun: "반신반의하며" }, // [검토 필요] 파생 문구
            ],
          },

          // 언제부터 시작되었는지. 기간은 구체적으로 적음.
          {
            id: "onset",
            label: "시작 시기",
            type: "text",
            placeholder: "예: 약 6개월 전",
          },

          // 그 망상 때문에 실제로 한 행동. 여러 개 고를 수 있음.
          {
            id: "impact",
            label: "행동 영향",
            type: "multi",
            exclusiveNormal: true,
            // [v2.1] 여러 개를 고르면 마지막 것만 end, 앞의 것은 mid(연결형 '~고')로 이어 붙는다.
            //        종결형을 쉼표로 나열하면 "옮김, 항의함."처럼 비문이 되기 때문이다.
            options: [
              { id: "none", ko: "없음", en: "", def: true, normal: true },
              { id: "move", ko: "이사·이직", en: "", mid: "이사하거나 직장을 옮기고", end: "이사하거나 직장을 옮김" }, // [검토 필요] 파생 문구
              { id: "report", ko: "신고·항의", en: "", mid: "신고하거나 항의하고", end: "신고하거나 항의함" }, // [검토 필요] 파생 문구
              { id: "avoidperson", ko: "특정인 회피", en: "", mid: "특정인을 회피하고", end: "특정인을 회피함" }, // [검토 필요] 파생 문구
              { id: "refusefood", ko: "식사 거부", en: "", mid: "식사를 거부하고", end: "식사를 거부함" }, // [검토 필요] 파생 문구
              // 칸을 비우면 문장이 통째로 사라지지 않도록 [미입력] 로 남긴다
              { id: "other", ko: "기타", en: "", reveal: ["impact_text"], mid: "{text}", end: "{text}", mid_notext: "{missing}", end_notext: "{missing}" }, // [검토 필요] 파생 문구
            ],
          },

          // 행동 영향에서 '기타'를 고르면 나타나는 칸.
          {
            id: "impact_text",
            label: "기타 행동 영향", // [검토 필요] 파생 문구
            type: "text",
            hidden: true,
            placeholder: "어떤 행동인지", // [검토 필요] 파생 문구
          },

        ],
      },

      // 자살·타해 사고 '있음'일 때 열리는 세부 틀. 모든 칸을 직접 물어서 채움.
      selfharm: {
        label: "자살·타해 사고",
        repeatable: false,
        groups: [

          // 죽고 싶다는 생각이 있는지. '있음'이면 빈도와 대상자 표현 칸이 열림.
          {
            id: "si",
            label: "자살사고",
            type: "single",
            options: [
              { id: "no", ko: "없음", en: "", normal: true },
              { id: "yes", ko: "있음", en: "", reveal: ["si_freq", "si_text"] },
            ],
          },

          // 자살사고가 얼마나 자주 드는지.
          // [검토 필요] 명세·계약에 ★기본값이 없어 def 를 두지 않음. 미선택이면 si_lead_da 의 {freq} 가 비므로 조립기에서 미입력 처리 규칙이 필요함.
          {
            id: "si_freq",
            label: "빈도",
            type: "single",
            hidden: true,
            options: [
              { id: "sometimes", ko: "가끔", en: "", noun: "가끔" },  // [v1.6] 기본값 없음 — 묻지 않은 빈도를 적지 않음
              { id: "often", ko: "자주", en: "", noun: "자주" },
              { id: "almost", ko: "거의 매일", en: "", noun: "거의 매일" },  // [검토 필요] 화면 라벨은 명세 5.7 표의 '거의 항상', 문장에 들어가는 말은 부록 B-2 예문의 '거의 매일' — 센터에서 하나로 정할 것
            ],
          },

          // 자살사고에 대한 대상자 표현. 요약하지 말고 말한 그대로 적음.
          {
            id: "si_text",
            label: "대상자 표현",
            type: "text",
            hidden: true,
            placeholder: "대상자 표현",
          },

          // 어떻게 할지 구체적으로 생각해 두었는지.
          {
            id: "plan",
            label: "구체적 계획",
            type: "single",
            // [v1.6] 기본값 없음 — 묻지 않은 것이 '부인함'으로 기록되면 안 됨
            options: [
              { id: "no", ko: "없음", en: "", normal: true },
              { id: "yes", ko: "있음", en: "", reveal: ["plan_text"] },
            ],
          },

          // 계획이 '있음'일 때 그 내용을 적는 칸.
          {
            id: "plan_text",
            label: "계획 내용", // [검토 필요] 파생 문구
            type: "text",
            hidden: true,
            placeholder: "어떤 계획인지", // [검토 필요] 파생 문구
          },

          // 실제로 할 수 있는 수단이 주변에 있는지.
          // [검토 필요] 명세 예시는 plan·means 둘 다 '없음'인 경우(plan_means_none)만 보여줌. 한쪽만 '있음'일 때 plan_yes/means_yes 를 어떻게 잇는지는 조립기에서 정해야 함.
          {
            id: "means",
            label: "수단 접근 가능성",
            type: "single",
            // [v1.6] 기본값 없음
            options: [
              { id: "no", ko: "없음", en: "", normal: true },
              { id: "yes", ko: "있음", en: "" },
            ],
          },

          // 실행 의도가 어느 정도로 표현되는지.
          {
            id: "intent",
            label: "의도",
            type: "single",
            options: [
              { id: "low", ko: "낮음", en: "", noun: "낮은" }, // [검토 필요] 파생 문구  // [v1.6] 기본값 없음
              { id: "mid", ko: "중간", en: "", noun: "중간" },
              { id: "high", ko: "높음", en: "", noun: "높은" }, // [검토 필요] 파생 문구
            ],
          },

          // 의도에 대한 대상자 표현(선택 입력).
          {
            id: "intent_text",
            label: "대상자 표현 (선택)",
            type: "text",
            placeholder: "대상자 표현 (선택)",
          },

          // 과거에 실제로 시도한 적이 있는지.
          {
            id: "past",
            label: "과거 시도",
            type: "single",
            // [v1.6] 기본값 없음
            options: [
              { id: "no", ko: "없음", en: "", normal: true },
              { id: "yes", ko: "있음", en: "", reveal: ["past_text"] },
            ],
          },

          // 과거 시도가 '있음'일 때 시기와 횟수를 적는 칸.
          {
            id: "past_text",
            label: "시기·횟수",
            type: "text",
            hidden: true,
            placeholder: "시기·횟수",
          },

          // 그 생각을 멈추게 하는 것(사람·관계 등)을 적는 칸.
          {
            id: "protective",
            label: "보호요인",
            type: "text",
            placeholder: "예: 어머니, 반려견",
          },

          // 누군가를 해치고 싶은 생각이 있는지.
          {
            id: "hi",
            label: "타해사고",
            type: "single",
            options: [
              { id: "no", ko: "없음", en: "", normal: true },
              { id: "yes", ko: "있음", en: "", reveal: ["hi_text"] },
            ],
          },

          // 타해사고가 '있음'일 때 대상과 내용을 적는 칸.
          {
            id: "hi_text",
            label: "대상·내용",
            type: "text",
            hidden: true,
            placeholder: "대상·내용",
          },

        ],
      },

    },

    // 결과 패널에 들어갈 문장 틀. {…}는 입력값으로 바뀜.
    outputs: {
      form_normal_check: "logical, coherence",
      // MHIS 라벨 (명세 5.7: intact = 해당 없음, impaired = 있음)
      status_intact: "intact",
      status_impaired: "impaired",
      check_tail: "Delusion: {del} / 자타해사고: {sh}",
      // 체크 안내 줄 모양. 아래 4줄은 계약 outputs 목록에 없는 추가 키 — 값은 부록 B의 "7) 사고" 줄에서 옴.
      form_line: "(1) {status} → {items}", // [검토 필요] 계약 목록 외 추가 키
      content_no: "(2) 무", // [검토 필요] 계약 목록 외 추가 키
      content_yes: "(2) 유", // [검토 필요] 계약 목록 외 추가 키
      content_yes_list: "(2) 유 → {list}", // [검토 필요] 계약 목록 외 추가 키
      form_summary: "사고 형태에서 {list} 소견 관찰됨", // [검토 필요] 파생 문구 + 계약 목록 외 추가 키
      // 사고 형태를 '부적절'로만 고르고 (1)-2 이상 항목을 하나도 고르지 않은 경우.
      // 무엇이 부적절했는지 확인하지 못한 것이므로 요약에서 조용히 빼지 않고 [미입력] 로 남긴다.
      form_summary_missing: "사고 형태가 부적절하나 세부 이상 항목은 {missing}", // [검토 필요] 파생 문구 + 계약 목록 외 추가 키
      // 결과 패널의 서술 칸 이름. 아래 3줄도 계약 목록 외 추가 키(값은 명세 5.7 결과 소제목 그대로).
      slot_delusion: "Delusion 서술 칸", // [검토 필요] 계약 목록 외 추가 키
      slot_selfharm: "자타해사고 서술 칸", // [검토 필요] 계약 목록 외 추가 키
      slot_etc: "기타 서술 칸", // [검토 필요] 계약 목록 외 추가 키
      // [v2.0] 망상은 대상자가 '부인'하는 증상이 아니므로 확인 여부로 적는다
      delusion_none: "면담 중 망상은 확인되지 않음", // [검토 필요] 파생 문구
      delusion_uncertain: "확신이 굳지 않아 망상 수준인지는 추가 확인이 필요함", // [검토 필요] 파생 문구 — [v2.0] 확신도가 '흔들림·반신반의'일 때
      abuse_line: "{list} 의심 소견 있음. {text}", // [검토 필요] 파생 문구 — [v2.0]
      abuse_line_notext: "{list} 의심 소견 있음. {missing} 관찰·진술된 사실이 적히지 않음", // [검토 필요] 파생 문구 — [v2.0.1] 사실 없는 판단문만 나가지 않게
      alert_abuse: "학대·방임 의심 — 아동·노인·장애인 학대는 신고 의무 대상입니다. 팀장에게 즉시 보고하고 센터 절차를 따르세요", // [검토 필요] 파생 문구 — [v2.0.1]
      delusion_lead: "{type}망상 있음",
      delusion_lead_unsure: "{type}망상 의심", // [검토 필요] 파생 문구 — [v2.0.1] 확신이 굳지 않을 때는 '있음'으로 단정하지 않음
      // [v2.1] 유형을 고르지 않았으면 "망상 있음"으로 뭉뚱그리지 않고 물어보지 못한 자리를 드러낸다
      delusion_lead_notype: "{missing} 망상 있음", // [검토 필요] 파생 문구
      delusion_lead_notype_unsure: "{missing} 망상 의심", // [검토 필요] 파생 문구
      // [검토 필요] _da 와 일반형의 선택 기준(대상자 표현이 '~한다'로 끝나면 _da)이 명세·계약에 없음 — 조립기 판단 규칙 필요. delusion_belief_da / si_lead_da 둘 다 해당.
      delusion_belief_da: "'{content}'고 {conviction} 믿고 있음",
      delusion_belief: "'{content}'{라고} {conviction} 믿고 있음",
      delusion_onset: "{onset}부터 시작되었으며, 이로 인해 {impact}",
      delusion_onset_only: "{onset}부터 시작됨", // [검토 필요] 파생 문구
      // [v2.1] 시작 시기를 묻지 못했으면 조용히 빼지 않고 지각 섹션의 command_unknown 과 같은 말투로 남긴다
      delusion_onset_unknown: "{missing} 시작 시기는 이번 면담에서 확인하지 못함", // [검토 필요] 파생 문구
      delusion_impact_only: "이로 인해 {impact}", // [검토 필요] 파생 문구
      selfharm_none: "자살사고 및 타해사고 부인함",
      si_lead_da: "자살사고 있음. '{text}'는 생각이 {freq} 든다고 보고함",
      si_lead: "자살사고 있음. '{text}'{라고} 말하며, 그러한 생각이 {freq} 든다고 보고함", // [검토 필요] 파생 문구
      si_plain: "자살사고 있음",
      // [v1.7] 대상자 표현은 없고 빈도만 고른 경우 — 고른 빈도가 기록에서 사라지던 것을 막음
      si_plain_freq: "자살사고 있음. 그러한 생각이 {freq} 든다고 보고함", // [검토 필요] 파생 문구
      plan_means_none: "구체적 계획과 수단 접근 가능성은 부인하나,",
      plan_means_none_end: "구체적 계획과 수단 접근 가능성은 부인함", // [검토 필요] 파생 문구
      plan_yes: "구체적으로 {text} 계획을 언급함",
      // [v2.1] 계획을 '있음'으로 고르고 내용 칸을 비운 경우. 계획이 있다는 위험 신호는 남기되, 적지 않은 내용을 지어내지 않는다
      plan_yes_notext: "구체적 계획이 있다고 하나 그 내용은 {missing}", // [검토 필요] 파생 문구
      plan_yes_notext_mid: "구체적 계획이 있다고 하나 그 내용은 {missing}이고,", // [검토 필요] 파생 문구 — 뒤에 오는 '~이며,'와 겹치지 않게 '이고,'
      // [v1.7] 계획·수단 중 한쪽만 '없음'을 고른 경우. 물어서 부인한 사실이 문장에서 빠지던 것을 막음
      plan_none_mid: "구체적 계획은 부인하나,", // [검토 필요] 파생 문구
      plan_none_end: "구체적 계획은 부인함", // [검토 필요] 파생 문구
      means_none_mid: "수단 접근 가능성은 부인하나,", // [검토 필요] 파생 문구
      means_none_end: "수단 접근 가능성은 부인함", // [검토 필요] 파생 문구
      // 뒤에 다른 조각이 이어질 때 쓰는 연결형
      plan_yes_mid: "구체적으로 {text} 계획을 언급하며,", // [검토 필요] 파생 문구
      means_yes_mid: "수단에 접근 가능한 상태이며,", // [검토 필요] 파생 문구 // [검토 필요] 파생 문구
      means_yes: "수단에 접근 가능한 상태임", // [검토 필요] 파생 문구
      intent: "의도는 {noun} 수준으로 표현함",
      past_no: "과거 시도력은 부인함", // [검토 필요] 파생 문구
      past_yes: "과거 시도력 {text}",
      // [v2.1] 과거 시도를 '있음'으로 고르고 시기·횟수 칸을 비운 경우 — '과거 시도력.' 이라는 토막 문장이 나가던 것을 막음
      past_yes_notext: "과거 시도력 있으나 시기·횟수는 {missing}", // [검토 필요] 파생 문구
      protective: "보호요인으로 {list}{을를} 언급함",
      si_no: "자살사고 부인함",
      si_unknown: "{missing} 자살사고 여부는 이번 면담에서 확인하지 못함",
      hi_unknown: "{missing} 타해사고 여부는 이번 면담에서 확인하지 못함", // [검토 필요] 파생 문구 — 자타해사고를 '있음'으로 열고 자살사고만 '없음'일 때
      intent_quote: "('{text}')", // 의도에 대한 대상자 표현을 덧붙일 때
      form_example: "사고 형태 예시 발화: '{text}'", // [검토 필요] 파생 문구 — 5.7 (1)-2 텍스트가 들어갈 자리
      hi_no: "타해사고 부인함",
      hi_yes: "타해사고 있음. {text}", // [검토 필요] 파생 문구
      // [v2.1] 타해사고를 '있음'으로 고르고 대상·내용 칸을 비운 경우 — '타해사고 있음.'만 남고 빈칸이 사라지던 것을 막음
      hi_yes_notext: "타해사고 있음. 대상과 내용은 {missing}", // [검토 필요] 파생 문구
      etc_item: "{label}: {text}",
      alert_si: "자살사고 있음 — 센터 위기평가 절차를 확인하세요",
      // [v1.6] 아래 넷은 적대적 검증에서 확인된 결함을 막기 위해 새로 넣은 문구
      si_unasked: "{missing} {list}{은는} 이번 면담에서 확인하지 못함", // [검토 필요] 파생 문구
      alert_hi: "타해사고 있음 — 센터 위기평가 절차와 대상자 보호조치를 확인하세요", // [검토 필요] 파생 문구
      alert_si_history: "현재 자살사고는 부인하나 계획·수단·과거 시도력 기록이 있음 — 센터 위기평가 절차를 확인하세요", // [검토 필요] 파생 문구
      alert_command_here: "자·타해 지시 명령 환청이 6) 지각에 기록됨 — 자살·타해 사고를 직접 확인하세요", // [검토 필요] 파생 문구
    },

    summary: { normal: "사고 형태 적절하고 망상은 확인되지 않으며 자타해사고 부인함" }, // [검토 필요] 파생 문구 — [v2.0] 망상은 부인 대상이 아님
  },

  /* ===== 8) 인지 (Cognition) ===== */
  {
    id: "cognition",
    order: 8,
    title_ko: "인지",
    title_en: "Cognition",
    mhis: "mixed",
    required_confirm: false,

    // 화면 오른쪽 가이드 패널에 뜨는 설명. 명세 5.8 "가이드 내용" 문단을 그대로 옮김.
    guide: {
      definition: "지남력·기억·집중력·추상적 사고를 면담과 질문으로 확인하는 영역. 확인한 방법과 실제 반응을 함께 기록함.",
      criteria: "교육 수준·나이·문화를 고려. 대부분 intact이므로 이상이 보일 때 근거를 남기는 것이 핵심. 갑자기 나빠졌으면 섬망·신체 원인·물질 사용 확인 필요 → 주치의 공유.",
      questions: [],
      // [검토 필요] 명세 5.8 에는 별도 "확인 질문" 목록이 없고 판단 기준 안에 확인 방법으로만 적혀 있음
      questions_note: "따로 정해진 질문 목록은 없음. ⓘ 의 판단 기준에 적힌 방법(날짜·장소 질문, 3단어 회상, 100-7, 거꾸로 말하기, 속담·유사점)으로 면담 중 자연스럽게 확인함.",
      examples: [
        "시간: 연도·월은 맞았으나 날짜와 요일 오답.",
        "immediate: 3단어 중 5분 후 1개만 회상.",
        "집중력: 100-7 계산에서 두 번째부터 오류, 면담 중 질문을 자주 되물음.",
        "추상적 사고: '돌다리도 두드려 보고 건너라'를 '다리를 두드린다'로 구체적으로만 해석.",
      ],
      mistakes: "묻지 않고 전부 intact 체크. 최소한 시간 지남력과 최근 기억은 면담 중 자연스럽게 확인.",
      extra: [
        { t: "MHIS 구조", d: "지남력 3줄, 기억 3줄, 집중력, 추상적 사고 — 각각 intact/impaired + 서술 칸." },
        { t: "지남력", d: "시간(오늘 날짜·요일·계절·연도), 장소(여기가 어디, 어느 동네), 사람(면담자가 누구·본인 이름·나이). 대략 맞으면 intact(날짜 하루 이틀 차이는 보통 intact)." },
        { t: "기억", d: "remote 과거 — 생년월일·출신 학교·과거 직장·중요한 사건처럼 확인 가능한 것 / recent 최근 — 어제 한 일, 오늘 아침 식사, 며칠 전 일 / immediate 즉각 — 단어 3개(예: 나무·자동차·모자)를 말해주고 바로 따라 말하기, 5분 뒤 다시 말해보기. 숫자 5~7자리 따라 말하기." },
        { t: "집중력", d: "100에서 7씩 빼기(93·86·79·72·65), 요일이나 달을 거꾸로 말하기, 3~4자리 숫자 거꾸로 말하기. 면담 중 질문을 놓치거나 되묻는 것도 근거." },
        { t: "추상적 사고", d: "속담 뜻(\"돌다리도 두드려 보고 건너라\"), 유사점(\"사과와 배의 공통점은?\" → \"과일\" = 추상적, \"둘 다 둥글다 / 색깔이 다르다\" = 구체적), 차이점." },
        { t: "요약문 규칙", d: "기본 \"지남력·기억·집중력·추상적 사고 모두 양호함.\" (확인 방법이 있으면 괄호로 병기)" },
      ],
    },

    groups: [

      // 지남력 — 시간: 오늘 날짜·요일·계절·연도를 아는지
      {
        id: "ori_time",
        label: "지남력 — 시간",
        mhis_label: "시간",
        cat: "ori",
        type: "single",
        guide: "시간(오늘 날짜·요일·계절·연도). 대략 맞으면 intact(날짜 하루 이틀 차이는 보통 intact).",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["ori_time_text"] },
        ],
      },
      // 시간 지남력이 impaired일 때만 나타나는 서술 칸
      {
        id: "ori_time_text",
        label: "지남력 — 시간",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 지남력 — 장소: 여기가 어디인지 아는지
      {
        id: "ori_place",
        label: "지남력 — 장소",
        mhis_label: "장소",
        cat: "ori",
        type: "single",
        guide: "장소(여기가 어디, 어느 동네). 대략 맞으면 intact.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["ori_place_text"] },
        ],
      },
      // 장소 지남력이 impaired일 때만 나타나는 서술 칸
      {
        id: "ori_place_text",
        label: "지남력 — 장소",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 지남력 — 사람: 면담자·본인이 누구인지 아는지
      {
        id: "ori_person",
        label: "지남력 — 사람",
        mhis_label: "사람",
        cat: "ori",
        type: "single",
        guide: "사람(면담자가 누구·본인 이름·나이). 대략 맞으면 intact.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["ori_person_text"] },
        ],
      },
      // 사람 지남력이 impaired일 때만 나타나는 서술 칸
      {
        id: "ori_person_text",
        label: "지남력 — 사람",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 기억 — remote(과거): 확인 가능한 옛 기억
      {
        id: "mem_remote",
        label: "기억 — remote(과거)",
        mhis_label: "remote",
        cat: "mem",
        type: "single",
        guide: "remote 과거 — 생년월일·출신 학교·과거 직장·중요한 사건처럼 확인 가능한 것.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["mem_remote_text"] },
        ],
      },
      // remote 기억이 impaired일 때만 나타나는 서술 칸
      {
        id: "mem_remote_text",
        label: "기억 — remote(과거)",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 기억 — recent(최근): 어제·오늘 있었던 일
      {
        id: "mem_recent",
        label: "기억 — recent(최근)",
        mhis_label: "recent",
        cat: "mem",
        type: "single",
        guide: "recent 최근 — 어제 한 일, 오늘 아침 식사, 며칠 전 일.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["mem_recent_text"] },
        ],
      },
      // recent 기억이 impaired일 때만 나타나는 서술 칸
      {
        id: "mem_recent_text",
        label: "기억 — recent(최근)",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 기억 — immediate(즉각): 3단어 회상·숫자 따라 말하기
      {
        id: "mem_immediate",
        label: "기억 — immediate(즉각)",
        mhis_label: "immediate",
        cat: "mem",
        type: "single",
        guide: "immediate 즉각 — 단어 3개(예: 나무·자동차·모자)를 말해주고 바로 따라 말하기, 5분 뒤 다시 말해보기. 숫자 5~7자리 따라 말하기.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["mem_immediate_text"] },
        ],
      },
      // immediate 기억이 impaired일 때만 나타나는 서술 칸
      {
        id: "mem_immediate_text",
        label: "기억 — immediate(즉각)",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 집중력: 100-7 빼기, 거꾸로 말하기, 면담 중 되묻는 정도
      {
        id: "concentration",
        label: "집중력",
        mhis_label: "집중력",
        cat: "",
        type: "single",
        guide: "100에서 7씩 빼기(93·86·79·72·65), 요일이나 달을 거꾸로 말하기, 3~4자리 숫자 거꾸로 말하기. 면담 중 질문을 놓치거나 되묻는 것도 근거.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["concentration_text"] },
        ],
      },
      // 집중력이 impaired일 때만 나타나는 서술 칸
      {
        id: "concentration_text",
        label: "집중력",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 추상적 사고: 속담 뜻·공통점 찾기
      {
        id: "abstract",
        label: "추상적 사고",
        mhis_label: "추상적 사고",
        cat: "",
        type: "single",
        guide: "속담 뜻(\"돌다리도 두드려 보고 건너라\"), 유사점(\"사과와 배의 공통점은?\" → \"과일\" = 추상적, \"둘 다 둥글다 / 색깔이 다르다\" = 구체적), 차이점.",
        options: [
          { id: "intact", ko: "intact", en: "intact", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "impaired", reveal: ["abstract_text"] },
        ],
      },
      // 추상적 사고가 impaired일 때만 나타나는 서술 칸
      {
        id: "abstract_text",
        label: "추상적 사고",
        type: "text",
        hidden: true,
        placeholder: "무엇을 어떻게 틀렸나",
      },

      // 어떤 방법으로 확인했는지 기록(선택). 결과 끝에 "(확인 방법: …)"로 붙음
      // 여러 개 고르면 조립기가 아래 ko 를 ", " 로 이어 붙임(문장 조각 없이 낱말 그대로 씀)
      {
        id: "method",
        label: "확인 방법 기록(선택)",
        type: "multi",
        options: [
          { id: "observe", ko: "면담 중 관찰로 판단", en: "" },
          { id: "datetime", ko: "날짜·장소 질문", en: "" },
          { id: "recall3", ko: "3단어 회상", en: "" },
          { id: "serial7", ko: "100-7", en: "" },
          { id: "reverse", ko: "거꾸로 말하기", en: "" },
          { id: "proverb", ko: "속담·유사점", en: "" },
        ],
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 결과 문장 틀. group_same 의 {group} 은 "지남력"/"기억", {labels} 는 "시간·장소·사람" 처럼 묶어서 들어감
    // {label} 자리에는 그룹의 mhis_label("시간","remote" …)이 들어감(그룹 label 아님)
    outputs: {
      method: "(확인 방법: {list})",
      item: "{label}: {text}",
      group_same: "{group} {labels} {status}",
      group_item: "{label} {status}",
      // 아래 3개는 체크 안내를 묶는 이름과 구분 기호. 문구는 부록 B "8) 인지" 줄 그대로이며
      // 조립기(index.html)가 O.ori_group / O.mem_group / O.sep 로 직접 읽으므로 지우지 말 것
      ori_group: "지남력",
      mem_group: "기억",
      sep: " / ",
    },

    summary: { normal: "지남력·기억·집중력·추상적 사고 모두 양호함" },
  },

  /* ===== 9) 판단력 (Judgment) ===== */
  {
    id: "judgment",
    order: 9,
    title_ko: "판단력",
    title_en: "Judgment",
    mhis: "mixed",
    required_confirm: false,

    // 화면 오른쪽 ⓘ 가이드 — 명세 5.9 "가이드 내용" 문단을 그대로 옮김
    guide: {
      definition: "상황을 이해하고 결과를 예상해 적절히 결정하는 능력.",
      criteria: "결과를 예상하지 못하거나, 알면서도 반복해서 해로운 선택을 하면 impaired. 병식(Insight)과 함께 봄 — 병식은 '병에 대한 이해', 판단력은 '행동 결정'.",
      // 가상 상황 질문 두 개(명세 5.9 확인 방법 (b))
      questions: [
        "길에서 주소와 우표가 붙은 편지를 주우면 어떻게 하시겠어요?",
        "극장에서 불이 난 걸 제일 먼저 발견하면요?"
      ],
      questions_note: "위 두 질문은 가상 상황(b). 실제 최근 결정·행동(a)을 먼저 확인하는 것이 더 유용함.", // [검토 필요] 파생 문구
      // 명세 5.9 "결과"의 서술 예시 두 개
      examples: [
        "판단력 양호함. 일상적 결정과 문제 상황 대처가 적절함.",
        "판단력 저하됨. 약 복용 중단 시 재발 위험을 알면서도 자의로 2주간 중단했고, 생활비를 받은 당일 대부분 소진함."
      ],
      mistakes: "가상 상황 답변 하나로 일상 판단력을 단정하지 않음. 최근의 실제 선택, 결과에 대한 이해와 당시 상황을 함께 확인함.",
      extra: [
        { t: "확인 방법 두 가지", d: "(a) 실제 최근 결정·행동(약 복용, 돈 관리, 위험 상황 대처, 대인 갈등 처리) — 이쪽이 더 유용. (b) 가상 상황: \"길에서 주소와 우표가 붙은 편지를 주우면 어떻게 하시겠어요?\" / \"극장에서 불이 난 걸 제일 먼저 발견하면요?\"" },
        // [검토 필요] 파생 문구 — 환각·망상 내용을 판단력 칸에 적는 실수를 막기 위한 안내
        { t: "여기에 적지 않는 것", d: "환청·환시·망상의 내용 자체는 6) 지각과 7) 사고에 적습니다. 판단력에는 '그래서 실제로 어떤 결정을 하고 어떻게 행동했는지'를 적습니다. 예: 환청 내용은 6)에, '환청 때문에 문을 잠그고 두 달간 외출하지 않음'은 9)에." },
      ],
    },

    groups: [

      // 판단력이 온전한지(intact) 저하되었는지(impaired) 하나만 고르는 칸. impaired 를 고르면 아래 칸들이 열림
      {
        id: "judgment",
        label: "판단력",
        type: "single",
        guide: "결과를 예상하지 못하거나, 알면서도 반복해서 해로운 선택을 하면 impaired. 병식(Insight)과 함께 봄 — 병식은 '병에 대한 이해', 판단력은 '행동 결정'.",
        options: [
          // ko 자체가 MHIS 영문 표기이므로 en 은 비움(8) 인지 섹션의 intact/impaired 와 같은 방식)
          { id: "intact", ko: "intact", en: "", def: true, normal: true },
          { id: "impaired", ko: "impaired", en: "", reveal: ["judgment_basis", "judgment_pattern"] },
        ],
      },

      // 무엇을 보고 판단했는지 (명세 5.9 확인 방법 (a)/(b)). 고른 쪽의 입력 칸이 열림
      {
        id: "judgment_basis",
        label: "무엇을 보고 판단했나",
        type: "multi",
        hidden: true,
        guide: "실제 최근 결정·행동(a)이 가상 상황 질문(b)보다 더 유용함.",
        options: [
          { id: "actual", ko: "실제 최근 결정·행동", en: "", def: true,
            reveal: ["judgment_area", "judgment_actual", "judgment_quote"] },
          { id: "hypothetical", ko: "가상 상황 질문 답변", en: "", reveal: ["judgment_hypo"] },
        ],
      },

      // 어느 영역에서 문제가 있었는지 (명세 5.9 확인 방법 (a) 의 네 가지 + 기타)
      {
        id: "judgment_area",
        label: "어느 영역인가 (여러 개 가능)",
        type: "multi",
        hidden: true,
        options: [
          { id: "med", ko: "약 복용", en: "", noun: "약 복용" },
          { id: "money", ko: "돈 관리", en: "", noun: "돈 관리" },
          { id: "risk", ko: "위험 상황 대처", en: "", noun: "위험 상황 대처" },
          { id: "conflict", ko: "대인 갈등 처리", en: "", noun: "대인 갈등 처리" },
          { id: "other", ko: "기타", en: "", noun: "그 밖의" }, // [검토 필요] 파생 문구
        ],
      },

      // 실제로 무엇을 어떻게 결정·행동했는지. 이 문장이 기록의 핵심임
      {
        id: "judgment_actual",
        label: "실제로 어떤 결정·행동이 있었나",
        type: "text",
        long: true,
        hidden: true,
        placeholder: "무엇을 어떻게 했는지 한 문장으로 (예: 재발 위험을 알면서도 자의로 2주간 약을 중단함)",
        // [검토 필요] 파생 문구 — 자주 쓰는 예시를 칩으로 둠
        chips: [
          "처방약을 임의로 중단함",
          "생활비를 받은 당일 대부분 소진함",
          "위험한 상황을 피하지 않음",
          "갈등 상황에서 공격적으로 대응함",
          "치료 권유를 반복해서 거부함",
        ],
      },

      // 대상자가 그 결정을 어떻게 설명했는지 (선택). 인용으로 들어감
      {
        id: "judgment_quote",
        label: "대상자는 그 결정을 어떻게 설명했나 (선택)",
        type: "text",
        hidden: true,
        placeholder: "대상자 표현 그대로 (예: 이제 다 나아서 약이 필요 없어요)", // [검토 필요] 파생 문구
      },

      // 가상 상황 질문(명세 5.9 (b))에 어떻게 답했는지
      {
        id: "judgment_hypo",
        label: "가상 상황 질문에 어떻게 답했나",
        type: "text",
        hidden: true,
        placeholder: "어떻게 답했는지 한 문장으로 (예: 극장에 불이 나면 그냥 나오겠다고 답함)", // [검토 필요] 파생 문구
      },

      // 판단이 어떤 식으로 저하되어 있는지 (명세 5.9 판단 기준). 고른 것만 문장으로 나감
      {
        id: "judgment_pattern",
        label: "어떤 양상인가 (여러 개 가능)",
        type: "multi",
        hidden: true,
        guide: "명세 5.9 판단 기준: 결과를 예상하지 못하거나, 알면서도 반복해서 해로운 선택을 하면 impaired.",
        options: [
          { id: "unforeseen", ko: "결과를 예상하지 못함", en: "",
            mid: "결과를 예상하지 못하고", end: "결과를 예상하지 못하는 모습을 보임" }, // [검토 필요] 파생 문구
          { id: "repeated", ko: "알면서도 반복함", en: "",
            mid: "위험을 알면서도 같은 선택을 반복하고", end: "위험을 알면서도 같은 선택을 반복함" }, // [검토 필요] 파생 문구
          { id: "symptom", ko: "증상(환각·망상)의 영향", en: "",
            mid: "환각·망상 등 증상이 판단에 영향을 미치는 것으로 보이고", end: "환각·망상 등 증상이 판단에 영향을 미치는 것으로 보임" }, // [검토 필요] 파생 문구
        ],
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 결과 문장 (명세 5.9 "결과")
    outputs: {
      intact: "판단력 양호함. 일상적 결정과 문제 상황 대처가 적절함",
      impaired_lead: "판단력 저하됨",
      // 실제 사례를 적지 않고 영역만 골랐을 때 쓰는 문장
      area_only: "{list} 영역에서 판단에 어려움을 보임", // [검토 필요] 파생 문구
      // 영역과 실제 사례를 둘 다 적었을 때 (둘 중 하나만 나가지 않도록)
      area_actual: "{list} 영역에서 판단에 어려움을 보임", // [검토 필요] 파생 문구
      quote: "대상자는 이에 대해 '{text}'{라고} 설명함", // [검토 필요] 파생 문구
      hypo: "가상 상황 질문에서는 {text}", // [검토 필요] 파생 문구
    },

    // 6.3 요약문용 정상 문장
    summary: { normal: "판단력 양호함" },
  },

  /* ===== 10) Insight (Insight) ===== */
  {
    id: "insight",
    order: 10,
    title_ko: "Insight",
    title_en: "Insight",
    mhis: "check",
    required_confirm: false,

    // ⓘ 가이드 — 명세 5.10 "가이드 내용"에서 옮김
    guide: {
      definition: "병식은 '병에 대한 이해', 판단력은 '행동 결정'.", // [검토 필요] 5.10에 '정의' 문단이 없어 명세 5.9 판단 기준 끝 문장을 그대로 옮김
      criteria: "문제에 대한 인식, 원인에 대한 설명, 도움의 필요성, 실제 행동을 함께 확인함. 질문 흐름의 제안 등급을 근거 발언과 비교해 최종 선택함.",
      questions: [
        "본인 상태를 어떻게 생각하세요?",
        "치료나 약이 필요하다고 보세요?",
        "왜 이런 일이 생겼다고 생각하세요?",
        "그래서 어떻게 하고 계세요?",
      ],
      // 서술 예시 — 첫 줄은 5.10 "결과 / 요약문용", 둘째 줄은 "결과 / 체크 안내"(부록 B-2 출력 예와 같은 형태).
      examples: [
        "병식은 III단계로, 증상은 인정하나 원인을 외부 요인에 둠('회사가 나를 이렇게 만들었다').",
        "Grade III — 병들었음을 인정하나 그 원인이 기질적 요인이나 외적 요인 혹은 타인에게 있다고 봄",
      ],
      mistakes: "약을 잘 먹는다고 VI로 체크. 약 복용은 V와 VI 모두 가능 — VI는 자기 패턴에 대한 이해가 생활 전반의 변화로 이어질 때.",
      extra: [
        {t:"방법 A — 질문 흐름(권장)", d:"답에 따라 등급이 자동 선택됨."},
        {t:"방법 B — 직접 선택", d:"I / II / III / IV / V / VI (MHIS 원문 그대로 표시)."},
        {t:"근거 발언(선택)", d:"텍스트. 대상자 표현. 요약문에 인용."},
        {t:"단계별 발언 예", d:"각 등급 옵션의 ⓘ(example)에 그 등급의 발언 예가 들어 있음."}, // [검토 필요] 파생 문구
      ],
    },

    groups: [

      // 병식 6단계 라디오 하나(방법 B). 기본값 없음 — 미선택이면 결과에 [미입력].
      // 각 등급의 ⓘ 설명은 mhis_text(MHIS 원문 한 줄)와 example(단계별 발언 예)을 그대로 씀.
      // 라디오 라벨은 ko(로마숫자) + mhis_text 를 함께 보여야 함("MHIS 원문 그대로 표시").
      // en 은 MHIS 영문 표기가 따로 없어 "" — 체크 안내 "Grade V" 는 outputs.check 이 ko 로 만듦.
      {
        id: "insight_flow",
        label: "방법 A — 질문 흐름(권장)",
        type: "flow",
        guide: "답에 따라 등급이 자동 선택됨.",
        flow: [
          {q:"자신에게 병(문제)이 있다고 인정하나?", a:[{t:"전혀 아님", grade:"g1"},{t:"약간 인정하나 동시에 부정", grade:"g2"},{t:"인정", next:1}]},
          {q:"원인을 어디에 두나?", a:[{t:"외부·타인·신체(기질적) 탓", grade:"g3"},{t:"자기 안의 알 수 없는 무언가", grade:"g4"},{t:"자기 정서·심리 문제로 이해", next:2}]},
          {q:"그 이해가 행동(치료·약·생활)으로 이어지나?", a:[{t:"아니오", grade:"g5"},{t:"예", grade:"g6"}]},
        ],
      },

      {
        id: "insight",
        label: "방법 B — 직접 선택",
        type: "single",
        required: true,
        guide: "I / II / III / IV / V / VI (MHIS 원문 그대로 표시).",
        options: [
          {
            id: "g1",
            ko: "I",
            en: "",
            guide: "질병의 전적인 부정",
            mhis_text: "질병의 전적인 부정",
            example: "나는 아무 문제 없어요. 가족이 이상한 거예요.",
            summary_frag: "병이 있음을 전적으로 부정함", // [검토 필요] 파생 문구
          },
          {
            id: "g2",
            ko: "II",
            en: "",
            guide: "병들었으나 도움이 필요한 상태라는 인식이 조금 있으며, 동시에 그렇지 않다고 생각함(부정)",
            mhis_text: "병들었으나 도움이 필요한 상태라는 인식이 조금 있으며, 동시에 그렇지 않다고 생각함(부정)",
            example: "힘든 건 맞는데 병까지는 아니에요.",
            summary_frag: "병이 있어 도움이 필요하다는 인식이 조금 있으나 동시에 그렇지 않다고도 여김", // [검토 필요] 파생 문구
          },
          {
            id: "g3",
            ko: "III",
            en: "",
            guide: "병들었음을 인정하나 그 원인이 기질적 요인이나 외적 요인 혹은 타인에게 있다고 봄",
            mhis_text: "병들었음을 인정하나 그 원인이 기질적 요인이나 외적 요인 혹은 타인에게 있다고 봄",
            example: "회사에서 괴롭혀서 이렇게 된 거예요.",
            summary_frag: "증상은 인정하나 원인을 외부 요인에 둠",
          },
          {
            id: "g4",
            ko: "IV",
            en: "",
            guide: "병들었으나 그 원인이 환자 자신 속에 있는 무엇인가 알 수 없는 것 때문이라고 여김",
            mhis_text: "병들었으나 그 원인이 환자 자신 속에 있는 무엇인가 알 수 없는 것 때문이라고 여김",
            example: "내 안에서 뭔가 잘못됐는데 뭔지 모르겠어요.",
            summary_frag: "증상은 인정하나 원인이 자기 안의 알 수 없는 무언가에 있다고 여김", // [검토 필요] 파생 문구
          },
          {
            id: "g5",
            ko: "V",
            en: "",
            guide: "지적 통찰: 자기가 병들었음을 인정하고 증상과 적응실패가 자신의 비합리적인 정서와 심리적 장애 때문임을 알지만 그러나 이해나 지식이 행동되지 않음",
            mhis_text: "지적 통찰: 자기가 병들었음을 인정하고 증상과 적응실패가 자신의 비합리적인 정서와 심리적 장애 때문임을 알지만 그러나 이해나 지식이 행동되지 않음",
            example: "내가 스트레스에 약해서 그런 건 아는데, 약은 안 먹어요.",
            summary_frag: "증상의 원인을 자신의 정서·심리 문제로 이해하나 행동으로 이어지지는 않음", // [검토 필요] 파생 문구
          },
          {
            id: "g6",
            ko: "VI",
            en: "",
            guide: "진실된 감정적 통찰: 환자 자신과 자신의 일생에 중요한 인물들의 동기와 느낌을 잘 알고 그러한 앎이 행동으로 옮겨져서 행동에 근본적인 변화가 일어남",
            mhis_text: "진실된 감정적 통찰: 환자 자신과 자신의 일생에 중요한 인물들의 동기와 느낌을 잘 알고 그러한 앎이 행동으로 옮겨져서 행동에 근본적인 변화가 일어남",
            example: "내 패턴을 알아서 약도 챙기고 힘들면 미리 연락해요.",
            summary_frag: "자신에 대한 이해가 행동 변화로 이어짐", // [검토 필요] 파생 문구
          },
        ],
      },

      {
        id: "insight_text",
        label: "근거 발언(선택)",
        type: "text",
        guide: "대상자 표현. 요약문에 인용.",
        placeholder: "근거 발언 — 대상자 표현",
      },


      // 이 항목에 대해 따로 남기고 싶은 말. 어느 항목에나 있음.
      // 결과 패널에 '기타 의견' 칸으로 따로 나오고, 전체 복사에도 한 줄로 들어감.
      {
        id: "opinion",
        label: "기타 의견 (선택)",
        type: "text",
        long: true,
        placeholder: "이 항목에 대해 남길 의견이 있으면 적으세요", // [검토 필요] 파생 문구
      },
    ],

    // 결과 문구. {roman} = 고른 등급의 ko 값(I~VI), {frag} = 그 등급의 summary_frag, {text} = 근거 발언
    outputs: {
      check: "Grade {roman}",
      summary_long: "병식은 {roman}단계로, {frag}",
      summary_quote: "('{text}')",
      summary_short: "병식 {roman}단계",
    },

    summary: { normal: "" },
  }

  ]
};

/* v2.6: 독자 작성한 상황별 서술 선택. 실제 환자 기록이나 진단 기준이 아님. */
(function(){
const choices={
  "appearance": [
    "복장·위생에 관해 질문하자 스스로 설명함",
    "외관 확인에 동의한 범위만 관찰함",
    "이전 면담과 외관을 비교할 자료가 없음",
    "겉옷을 벗은 뒤 복장을 추가로 확인함",
    "외관에 대한 본인 설명과 직접 관찰 내용을 구분해 기록함"
  ],
  "attitude": [
    "면담 목적을 설명한 뒤 질문에 응하는 정도가 늘어남",
    "답변하기 어려운 질문은 건너뛰고 싶다고 말함",
    "동행인과 따로 면담하기를 요청함",
    "면담 중 자신의 설명이 맞게 전달됐는지 확인함",
    "휴식을 요청한 뒤 면담을 이어감"
  ],
  "behavior": [
    "질문을 듣는 동안 손을 만지작거리는 모습이 관찰됨",
    "면담 도중 자리에서 일어났다가 다시 앉음",
    "소음이 들리자 그 방향을 여러 차례 바라봄",
    "휴식 뒤 자리에 앉아 면담을 이어감",
    "면담 중 휴대전화를 반복해서 확인함"
  ],
  "speech": [
    "질문이 끝난 뒤 답변을 시작하기까지 시간이 걸림",
    "질문을 짧게 나누어 제시하자 답변을 이어감",
    "말소리가 작아 내용을 다시 확인함",
    "대상자의 요청에 따라 필담을 함께 사용함",
    "일부 표현의 의미를 대상자에게 다시 확인함"
  ],
  "mood": [
    "대상자는 여러 감정이 섞여 한 가지로 말하기 어렵다고 함",
    "대상자는 하루 중 시간대에 따라 기분이 달라진다고 말함",
    "기분에 대한 질문에 대상자는 잘 모르겠다고 답함",
    "특정 이야기를 할 때 눈물을 보임",
    "면담 후반에 표정이 이완되는 모습이 관찰됨"
  ],
  "perception": [
    "보고한 경험이 잠들기 직전 또는 깨어날 무렵에 있었다고 말함",
    "보고한 경험이 있었던 시점과 현재 경험을 구분해 설명함",
    "외부의 소리인지 자신의 경험인지 확신하기 어렵다고 말함",
    "보고한 경험이 수면이나 일상에 미친 영향을 추가로 질문함",
    "면담 중 관찰된 반응과 대상자가 보고한 경험을 구분해 확인함"
  ],
  "thought": [
    "질문의 핵심을 다시 제시하자 원래 주제로 돌아옴",
    "대상자의 표현이 뜻하는 바를 다시 질문해 확인함",
    "걱정하는 내용과 실제로 일어난 일을 구분해 질문함",
    "같은 주제로 여러 차례 돌아와 이야기함",
    "진술 중 서로 다른 내용이 있어 대상자에게 다시 확인함"
  ],
  "cognition": [
    "청력 문제를 호소하여 질문을 다시 들려준 뒤 응답을 확인함",
    "질문을 쉬운 말로 바꾼 뒤 이해 여부를 확인함",
    "주변 소음을 줄인 뒤 집중 여부를 다시 관찰함",
    "대상자가 피로를 호소하여 휴식 후 질문을 이어감",
    "학력·언어 배경을 고려하여 질문의 의미를 설명함"
  ],
  "judgment": [
    "실제로 있었던 선택과 가정한 상황에 대한 답변을 구분해 질문함",
    "결정을 내릴 때 고려한 이유를 대상자에게 질문함",
    "도움을 요청할 수 있는 사람이나 기관을 대상자가 설명함",
    "선택한 행동의 결과를 어떻게 예상했는지 질문함",
    "판단의 근거가 되는 구체적 행동은 추가 확인이 필요함"
  ],
  "insight": [
    "대상자가 자신의 어려움을 어떤 말로 설명하는지 확인함",
    "도움이 필요한 부분과 혼자 해결하고 싶은 부분을 구분해 말함",
    "약물 복용에 대한 우려나 불편을 대상자가 설명함",
    "치료 필요성에 대한 생각이 이전과 달라졌다고 말함",
    "동의하는 치료와 동의하기 어려운 치료를 구분해 설명함"
  ]
};

  CONTENT.sections.forEach(function(sec){
    var group={id:'observations',type:'multi',collapsible:true,label:'상황별 관찰·진술 선택 (선택 사항)',
      guide:'실제 면담에서 확인한 내용만 선택하세요. 아래 문장은 특정 질환이나 정상 여부를 판정하지 않습니다. 기존 선택과 다르면 함께 수정하세요. 생성된 추가 서술은 기관 서식의 기록 위치를 확인한 뒤 옮기세요.',
      options:choices[sec.id].map(function(text,i){return {id:'note'+(i+1),ko:text,narrative:text};})};
    if(sec.id==='appearance') group.showIf={group:'contact_mode',notIn:['phone','online']};
    sec.groups.splice(sec.groups.findIndex(function(g){return g.id==='opinion';}),0,group);

  });
}());

/* v2.7: 기존 소견을 선택할 때만 표시하는 임상 세부 기록. */
(function(){
var groups=[
  {
    "sec": "behavior",
    "id": "detail_slow",
    "label": "지체·활동저조 — 구체적 움직임",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "behavior",
        "in": [
          "retarded",
          "hypoactivity"
        ]
      }
    ],
    "guide": "직접 본 움직임을 고르세요. 통증·피로·약물 영향 등 원인을 이 선택만으로 정하지 않습니다.",
    "options": [
      {
        "id": "d1",
        "ko": "동작 시작이 늦음",
        "narrative": "면담 중 요청을 듣고 움직이기 시작하기까지 시간이 걸리는 모습이 관찰됨."
      },
      {
        "id": "d2",
        "ko": "자발적 움직임 감소",
        "narrative": "면담 중 자발적인 몸짓과 자세 변화가 적게 관찰됨."
      },
      {
        "id": "d3",
        "ko": "동작 전반이 느림",
        "narrative": "자세를 바꾸거나 물건을 집는 동작이 전반적으로 느리게 관찰됨."
      }
    ]
  },
  {
    "sec": "behavior",
    "id": "detail_restless",
    "label": "초조·과활동 — 구체적 움직임",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "behavior",
        "in": [
          "agitation",
          "overactivity"
        ]
      }
    ],
    "guide": "초조의 원인을 추정하지 말고 면담에서 관찰한 행동을 고르세요.",
    "options": [
      {
        "id": "d1",
        "ko": "서성거림",
        "narrative": "면담 공간을 반복해서 오가는 모습이 관찰됨."
      },
      {
        "id": "d2",
        "ko": "손을 반복해서 비빔",
        "narrative": "면담 중 두 손을 반복해서 비비는 모습이 관찰됨."
      },
      {
        "id": "d3",
        "ko": "앉았다 일어남 반복",
        "narrative": "면담 중 앉았다 일어나는 행동이 반복됨."
      }
    ]
  },
  {
    "sec": "behavior",
    "id": "detail_compulsion",
    "label": "강박행위 — 행동과 본인 설명",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "behavior",
        "in": [
          "compulsion"
        ]
      }
    ],
    "guide": "반복 행동만으로 강박행위로 판단하지 않습니다. 아래 보고형 문장은 대상자에게 실제로 들은 경우에 선택하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "씻어도 더럽다고 느껴 다시 씻음",
        "narrative": "대상자는 씻은 뒤에도 더럽다는 느낌이 남아 다시 씻는다고 말함."
      },
      {
        "id": "d2",
        "ko": "문·가스 등을 반복 확인",
        "narrative": "대상자는 문이나 가스 등을 확인한 뒤에도 의심이 남아 반복해서 확인한다고 말함."
      },
      {
        "id": "d3",
        "ko": "반복 행동을 멈추면 불안 증가",
        "narrative": "대상자는 반복 행동을 멈추려 하면 불안이 커진다고 말함."
      }
    ]
  },
  {
    "sec": "speech",
    "id": "detail_reduced",
    "label": "말수 감소·언어빈곤 — 응답 양상",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "productivity",
        "in": [
          "decreased",
          "poverty"
        ]
      }
    ],
    "guide": "말의 양, 속도와 답변 시작까지 걸리는 시간은 구분합니다. 침묵만으로 사고차단이라 정하지 않습니다.",
    "options": [
      {
        "id": "d1",
        "ko": "질문 후 긴 침묵 뒤 답함",
        "narrative": "질문이 끝난 뒤 한동안 침묵하다가 답변을 시작함."
      },
      {
        "id": "d2",
        "ko": "단어·짧은 구절로 답함",
        "narrative": "대부분의 질문에 한두 단어나 짧은 구절로 답함."
      },
      {
        "id": "d3",
        "ko": "추가 질문을 해야 설명함",
        "narrative": "추가 질문을 제시해야 설명을 조금씩 이어감."
      }
    ]
  },
  {
    "sec": "speech",
    "id": "detail_pressure",
    "label": "말수 증가·압박 — 대화 진행",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "productivity",
        "in": [
          "increase",
          "pressure"
        ]
      }
    ],
    "guide": "말이 많은 것과 빠른 것은 별개입니다. 실제 말의 속도는 기존 속도 항목에서 별도로 선택하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "질문 중 말을 시작함",
        "narrative": "면담자의 질문이 끝나기 전에 답변을 시작하는 모습이 반복됨."
      },
      {
        "id": "d2",
        "ko": "중간에 끼어들기 어려움",
        "narrative": "말이 이어져 면담자가 질문을 덧붙이거나 화제를 정리하기 어려움."
      },
      {
        "id": "d3",
        "ko": "중단 요청 뒤에도 말을 이어감",
        "narrative": "잠시 멈추어 달라는 요청 뒤에도 말을 이어가는 모습이 관찰됨."
      }
    ]
  },
  {
    "sec": "mood",
    "id": "detail_low",
    "label": "우울·슬픔·절망 — 대상자 보고",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "mood",
        "in": [
          "depressed",
          "sad",
          "despaired"
        ]
      }
    ],
    "guide": "기분과 관련해 대상자가 실제로 보고한 내용을 선택합니다. 눈물만으로 우울감을 추정하지 않습니다. 자살·타해사고는 기존 사고 항목에서 따로 확인합니다.",
    "options": [
      {
        "id": "d1",
        "ko": "즐거움이 줄었다고 함",
        "narrative": "대상자는 이전에 즐기던 일에서도 즐거움을 느끼기 어렵다고 말함."
      },
      {
        "id": "d2",
        "ko": "자신을 자책한다고 함",
        "narrative": "대상자는 자신의 잘못이나 부족함을 반복해서 자책한다고 말함."
      },
      {
        "id": "d3",
        "ko": "아무것도 하기 싫다고 함",
        "narrative": "대상자는 일상적인 활동을 시작할 의욕이 나지 않는다고 말함."
      }
    ]
  },
  {
    "sec": "mood",
    "id": "detail_labile",
    "label": "불안정한 정서 — 관찰 양상",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "affect_type",
        "in": [
          "labile"
        ]
      }
    ],
    "guide": "짧은 시간 안의 정서 표현 변화를 관찰해 기록합니다. 주제에 맞는 자연스러운 감정 변화와 구분하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "울음에서 웃음으로 급변",
        "narrative": "면담 중 울다가 짧은 시간 안에 웃는 모습으로 바뀜."
      },
      {
        "id": "d2",
        "ko": "웃다가 갑자기 화를 냄",
        "narrative": "면담 중 웃는 모습에서 갑자기 화를 내는 모습으로 바뀜."
      },
      {
        "id": "d3",
        "ko": "표정·목소리의 감정 변화 큼",
        "narrative": "짧은 시간 동안 표정과 목소리에 드러나는 감정이 크게 달라짐."
      }
    ]
  },
  {
    "sec": "thought",
    "id": "detail_circum",
    "label": "우회적 사고 — 답에 도달하는 방식",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "form",
        "in": [
          "inappropriate"
        ]
      },
      {
        "group": "form_items",
        "in": [
          "circumstantiality"
        ]
      }
    ],
    "guide": "우회적 사고는 곁가지가 많아도 결국 질문에 답합니다. 끝내 답하지 못하면 사고의 이탈과 구분해 검토하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "세부 설명 뒤 질문에 답함",
        "narrative": "관련된 세부 설명을 길게 한 뒤 원래 질문에 답함."
      },
      {
        "id": "d2",
        "ko": "경위를 반복 설명하고 결론에 도달",
        "narrative": "일의 경위를 반복해서 설명하나 결국 질문의 결론에 도달함."
      },
      {
        "id": "d3",
        "ko": "질문을 다시 짚어 주면 답함",
        "narrative": "곁가지 설명이 이어지다가 질문을 다시 짚어 주면 핵심에 답함."
      }
    ]
  },
  {
    "sec": "thought",
    "id": "detail_tangent",
    "label": "사고의 이탈 — 주제에서 벗어남",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "form",
        "in": [
          "inappropriate"
        ]
      },
      {
        "group": "form_items",
        "in": [
          "tangentiality"
        ]
      }
    ],
    "guide": "연결되지 않는 말을 한다는 이유만으로 모두 지리멸렬로 묶지 않습니다. 원래 질문에 답했는지를 확인하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "다른 주제로 옮겨가 답하지 않음",
        "narrative": "질문에 답하다 다른 주제로 옮겨가 원래 질문에 대한 답에 도달하지 못함."
      },
      {
        "id": "d2",
        "ko": "질문을 다시 해도 다른 이야기",
        "narrative": "원래 질문을 다시 제시해도 다른 이야기로 이어짐."
      },
      {
        "id": "d3",
        "ko": "반복적인 주제 안내가 필요",
        "narrative": "면담 주제를 유지하기 위해 반복해서 질문의 초점을 안내해야 함."
      }
    ]
  },
  {
    "sec": "thought",
    "id": "detail_block",
    "label": "사고차단 — 중단과 본인 설명",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "form",
        "in": [
          "inappropriate"
        ]
      },
      {
        "group": "form_items",
        "in": [
          "blocking"
        ]
      }
    ],
    "guide": "관찰된 침묵과 대상자가 말한 생각의 중단을 구분합니다. 단순히 대답이 늦거나 말을 꺼리는 상태만으로 사고차단이라 단정하지 않습니다.",
    "options": [
      {
        "id": "d1",
        "ko": "말하던 중 문장을 갑자기 멈춤",
        "narrative": "문장을 말하던 중 갑자기 멈추고 한동안 말을 이어가지 못함."
      },
      {
        "id": "d2",
        "ko": "생각이 끊겼다고 설명함",
        "narrative": "대상자는 말을 멈춘 이유에 대해 생각이 갑자기 끊겼다고 설명함."
      },
      {
        "id": "d3",
        "ko": "무슨 말을 하려 했는지 잊었다고 함",
        "narrative": "대상자는 말이 멈춘 뒤 무슨 말을 하려 했는지 떠오르지 않는다고 말함."
      }
    ]
  },
  {
    "sec": "thought",
    "id": "detail_obsession",
    "label": "강박적 사고 — 경험의 특성",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "content_abn",
        "in": [
          "yes"
        ]
      },
      {
        "group": "content_items",
        "in": [
          "obsession"
        ]
      }
    ],
    "guide": "반복되는 걱정·반추와 원치 않는 침투적 생각을 구분합니다. 선택만으로 망상 여부나 병식 단계를 바꾸지 않습니다.",
    "options": [
      {
        "id": "d1",
        "ko": "원치 않는 생각이 반복됨",
        "narrative": "대상자는 원하지 않는 생각이 반복해서 떠오른다고 말함."
      },
      {
        "id": "d2",
        "ko": "생각을 떨치려 하지만 어려움",
        "narrative": "대상자는 그 생각을 떨치려 해도 잘 되지 않는다고 말함."
      },
      {
        "id": "d3",
        "ko": "생각으로 인해 불안·불편을 느낌",
        "narrative": "대상자는 반복해서 떠오르는 생각 때문에 불안하거나 괴롭다고 말함."
      }
    ]
  },
  {
    "sec": "perception",
    "id": "detail_voice",
    "label": "환청 — 들리는 경험의 양상",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "hallucination",
        "in": [
          "auditory"
        ]
      }
    ],
    "guide": "대상자가 보고한 경험만 고릅니다. 위험한 행동을 지시하는 내용은 기존 환청의 명령 내용과 자타해사고 항목에 구체적으로 기록하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "자신을 부르는 목소리",
        "narrative": "대상자는 자신을 부르는 목소리가 들린다고 말함."
      },
      {
        "id": "d2",
        "ko": "자신을 비난하는 목소리",
        "narrative": "대상자는 자신을 비난하는 내용의 목소리가 들린다고 말함."
      },
      {
        "id": "d3",
        "ko": "여러 목소리의 대화",
        "narrative": "대상자는 여러 목소리가 서로 대화하는 것처럼 들린다고 말함."
      }
    ]
  },
  {
    "sec": "perception",
    "id": "detail_illusion",
    "label": "착각 — 실제 자극과 재확인",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "other_perception",
        "in": [
          "illusion"
        ]
      }
    ],
    "guide": "실제로 있던 자극을 다르게 지각한 경험을 기록합니다. 외부 자극이 없었던 환각과 구분하세요.",
    "options": [
      {
        "id": "d1",
        "ko": "물건·그림자를 사람으로 오인",
        "narrative": "대상자는 실제 있던 물건이나 그림자를 사람으로 잘못 보았다고 말함."
      },
      {
        "id": "d2",
        "ko": "환경 소리를 다른 소리로 오인",
        "narrative": "대상자는 실제 주변 소리를 다른 소리로 잘못 들었다고 말함."
      },
      {
        "id": "d3",
        "ko": "가까이 보거나 재확인 후 알아차림",
        "narrative": "대상자는 가까이 보거나 다시 확인한 뒤 실제 대상이 무엇인지 알아차렸다고 말함."
      }
    ]
  },
  {
    "sec": "cognition",
    "id": "detail_attention",
    "label": "집중력 저하 — 관찰한 수행",
    "type": "multi",
    "clinicalNarrative": true,
    "narrativeWhen": [
      {
        "group": "concentration",
        "in": [
          "impaired"
        ]
      }
    ],
    "guide": "수행을 기록하되 피로·청력·언어·교육 수준 등 영향을 함께 검토합니다. 검사 점수나 진단을 자동 산출하지 않습니다.",
    "options": [
      {
        "id": "d1",
        "ko": "주변 자극에 주의가 쉽게 옮겨감",
        "narrative": "면담 중 주변 소리나 움직임에 주의가 쉽게 옮겨감."
      },
      {
        "id": "d2",
        "ko": "과제 중 지시를 놓침",
        "narrative": "과제를 진행하는 도중 지시 내용을 놓쳐 다시 설명해야 함."
      },
      {
        "id": "d3",
        "ko": "시작한 과제를 지속하기 어려움",
        "narrative": "과제를 시작하지만 끝까지 집중을 유지하기 어려운 모습이 관찰됨."
      }
    ]
  }
];
groups.forEach(function(g){var sec=CONTENT.sections.find(function(s){return s.id===g.sec;});var anchor=g.narrativeWhen[g.narrativeWhen.length-1].group;var pos=sec.groups.findIndex(function(x){return x.id===anchor;});sec.groups.splice(pos+1,0,g);});
}());
