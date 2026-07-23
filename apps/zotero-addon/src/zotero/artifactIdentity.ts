/**
 * 产物标识：判断某个附件是不是 UniZero 生成的，以及它是哪一份产物。
 *
 * ZoMiner 靠附件标题识别产物（"ZoMiner MD" 等固定字符串），有两个后果：
 *
 * 1. 用户重命名附件 → 下次转换找不到它，新建一份，条目下出现重复；
 * 2. 用户自己建了一个恰好同名的附件 → **被 eraseTx() 删掉**。
 *
 * 第二条是数据丢失，而判据只是一个字符串相等。所以这里把"所有权"和"是哪一份"分成
 * 两件事，用两种可靠性不同的机制承载：
 *
 * - **所有权 = 标签。** 只有带 `unizero:` 标签的附件才允许被覆盖或删除。标签随 Zotero
 *   同步，用户改标题不影响它。这条修掉了上面第 2 点，是整个模块的承重部分。
 * - **区分同类产物 = 附件 note 里的记录。** 一个条目挂多个 PDF 时，每个 PDF 各产出一份
 *   Markdown，标题靠后缀区分。note 里记下源 PDF 的 key，就不必再依赖标题。
 *
 * note 这条是加固而不是承重：Zotero 对 note HTML 的处理不在本插件掌控内，万一 HTML
 * 注释被清掉，读不出记录时会退回按标题区分——也就是今天的行为，不产生新的退化。
 *
 * 标签一共只有四个（每类产物一个），不会污染标签选择器；用 automatic 类型，用户可以
 * 在标签选择器里隐藏它们。
 */

export type ArtifactKind = "markdown" | "markdown-copy" | "tables" | "references";

const TAG_PREFIX = "unizero:";

/** Zotero 的 automatic tag。用户可在标签选择器里一键隐藏这类标签。 */
const AUTOMATIC_TAG = 1;

/** 记录格式版本。将来改结构时靠它决定怎么读旧记录。 */
const RECORD_SCHEMA = 1;

const NOTE_MARKER = /<!--\s*unizero:(\{[\s\S]*?\})\s*-->/;

interface ArtifactRecord {
  kind: ArtifactKind;
  /** 生成这份产物的源 PDF 附件 key。同一条目有多个 PDF 时靠它区分。 */
  source: string;
  schema: number;
}

export function kindTag(kind: ArtifactKind): string {
  return TAG_PREFIX + kind;
}

/** 是不是 UniZero 生成的产物——即是否允许我们覆盖或删除它。 */
export function isArtifact(attachment: Zotero.Item): boolean {
  return attachment.getTags().some((tag) => tag.tag.startsWith(TAG_PREFIX));
}

function hasKind(attachment: Zotero.Item, kind: ArtifactKind): boolean {
  const wanted = kindTag(kind);
  return attachment.getTags().some((tag) => tag.tag === wanted);
}

function readRecord(attachment: Zotero.Item): ArtifactRecord | null {
  try {
    const match = NOTE_MARKER.exec(attachment.getNote() || "");
    if (!match) { return null; }
    const parsed = JSON.parse(match[1]);
    if (!parsed || typeof parsed.kind !== "string") { return null; }
    return parsed as ArtifactRecord;
  } catch (error) {
    // note 读不出来或不是我们写的格式，当作没有记录。
    return null;
  }
}

function noteFor(kind: ArtifactKind, source: string): string {
  const record: ArtifactRecord = { kind, source, schema: RECORD_SCHEMA };
  return (
    `<p>UniZero 生成的产物（${kind}）。重新转换时会被覆盖，请勿在此手工编辑。</p>` +
    `<!--unizero:${JSON.stringify(record)}-->`
  );
}

/**
 * 打上所有权标签，并尽力写入结构化记录。
 *
 * **分两次事务提交，顺序不能反。** 标签是后续允许删除这份附件的唯一依据；它写不进去就
 * 该让整次登记失败，因为静默失败会让下一次转换把这份产物当成用户自己的文件而不敢覆盖，
 * 于是无声地堆重复。note 只影响多 PDF 场景下的区分精度——把它和标签放进同一个事务，就
 * 等于让一个加固手段有权否决一个承重手段。
 */
export async function markArtifact(
  attachment: Zotero.Item,
  kind: ArtifactKind,
  source: string,
): Promise<void> {
  attachment.addTag(kindTag(kind), AUTOMATIC_TAG);
  await attachment.saveTx();

  try {
    // setNote 用返回值而不是异常报告失败，两种都要接住。
    if (!attachment.setNote(noteFor(kind, source))) {
      ztoolkit.log(`artifact note refused for ${attachment.key}`);
      return;
    }
    await attachment.saveTx();
  } catch (error) {
    ztoolkit.log(`artifact note not written for ${attachment.key}: ${error}`);
  }
}

/**
 * 找出父条目下属于我们的某类产物。
 *
 * `expectedTitle` 只在附件没有结构化记录时才参与判断——有记录就以记录为准，用户改标题
 * 不影响识别。这正是重命名不再产生重复的地方。
 */
export function findArtifacts(
  parent: Zotero.Item,
  kind: ArtifactKind,
  source: string,
  expectedTitle: string,
): Zotero.Item[] {
  const found: Zotero.Item[] = [];
  for (const id of parent.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (!attachment || !hasKind(attachment, kind)) { continue; }

    const record = readRecord(attachment);
    if (record) {
      if (record.source === source) { found.push(attachment); }
      continue;
    }
    // 没有记录：退回标题匹配，也就是迁移前的区分方式。
    if (attachment.getField("title") === expectedTitle) { found.push(attachment); }
  }
  return found;
}

/**
 * 认领一份迁移前生成的产物：补上标签和记录，之后它就走强路径了。
 *
 * 这样已有用户不需要任何迁移脚本——第一次重新转换时旧产物自动升级。代价是必须先用
 * 标题认出它，而这一步的误判风险由调用方通过更严格的前置条件来压（见
 * conversionAdapter 里的 legacy 判定）。
 */
export async function adoptArtifact(
  attachment: Zotero.Item,
  kind: ArtifactKind,
  source: string,
): Promise<void> {
  ztoolkit.log(`adopting legacy artifact ${attachment.key} as ${kind}`);
  await markArtifact(attachment, kind, source);
}
