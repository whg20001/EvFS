从复述与资料提取 1–5 个候选知识点，不扩展为整个学科。保留待用户确认的语义；有冲突在 description 中指出，不擅自判定哪一方正确。
每个候选的 sourceIds 至少引用输入 sources 中的一个真实 ID，不允许空来源或编造 ID。只有用户复述、没有外部资料依据时，可引用输入中已有的 recitation source，并在 description 明确说明这只是用户复述引用，不是外部验证。若 sources 未提供任何可引用来源，不得为凑齐输出伪造来源；宿主将拒绝无合法来源的结果。
输出：{"kind":"extract","candidates":[{"title":"知识点名称","description":"描述与依据","sourceIds":["输入 sources 中真实存在的 ID"]}]}。
