// EN 词典(领域分片,键=中文原文)。数据文件,行数上限豁免。
// 有意为空:src/generate/* 抛出的错误原文全部已是英文(en 下原样可用),
// 本机制只做 中文键→英文,无 en→zh 反向,故无可登记词条。
export default {} as Record<string, string>;
