using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

public enum MarkdownBlockKind
{
    Heading,
    Paragraph,
    Code,
    Quote,
    List,
    Rule,
    Table,
    Embed,
}

public sealed class MarkdownSpan
{
    /// <summary>Span text. A single "\n" is a hard line break.</summary>
    public string Text;
    public bool Bold;
    public bool Italic;
    public bool Code;
    /// <summary>URL, relative path or wikilink target. Null for plain text.</summary>
    public string Link;
    public bool IsWikiLink;
    /// <summary>Obsidian ==highlight==.</summary>
    public bool Highlight;
}

public sealed class MarkdownBlock
{
    public MarkdownBlockKind Kind;
    public int HeadingLevel;
    public List<MarkdownSpan> Spans;
    public string CodeText;
    public List<MarkdownBlock> Children;
    public List<List<MarkdownBlock>> ListItems;
    public bool Ordered;
    public int FirstNumber;
    /// <summary>Table rows; the first row is the header. Each row has the header column count.</summary>
    public List<List<List<MarkdownSpan>>> TableRows;
    public string EmbedTarget;
    /// <summary>True for ![alt](path), where the target is a path relative to the file. False for ![[name]].</summary>
    public bool EmbedIsPath;
}

/// <summary>
/// Line-based Markdown parser for the Inspector. Covers CommonMark basics, GitHub tables and Obsidian wikilinks and embeds.
/// Syntax it does not know stays as plain text.
/// </summary>
public static class MarkdownParser
{
    private static readonly Regex HeadingPattern = new Regex(@"^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$");
    private static readonly Regex RulePattern = new Regex(@"^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$");
    private static readonly Regex QuotePattern = new Regex(@"^ {0,3}> ?(.*)$");
    private static readonly Regex ListItemPattern = new Regex(@"^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$");
    private static readonly Regex TableSeparatorPattern = new Regex(@"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$");
    private static readonly Regex EmbedPattern = new Regex(@"^!\[\[([^\]]+)\]\]$");
    private static readonly Regex ImagePattern = new Regex(@"^!\[[^\]]*\]\(<?([^)>]+?)>?\)$");
    private static readonly Regex CommentPattern = new Regex("%%.*?%%", RegexOptions.Singleline);
    private static readonly Regex CalloutPattern = new Regex(@"^\[!(\w+)\][+-]?\s*(.*)$");
    private static readonly Regex AutoLinkPattern = new Regex(@"\G<(https?://[^>\s]+)>");

    public static List<MarkdownBlock> Parse(string source)
    {
        // Obsidian comments do not show in reading view.
        List<string> lines = CommentPattern.Replace(source.Replace("\r\n", "\n").Replace('\r', '\n'), string.Empty).Split('\n').ToList();
        var blocks = new List<MarkdownBlock>();
        // Obsidian properties (YAML front matter) show as a code block.
        if (lines.Count > 0 && lines[0].TrimEnd() == "---")
        {
            int end = lines.FindIndex(1, line => line.TrimEnd() == "---");
            if (end > 0)
            {
                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Code, CodeText = string.Join("\n", lines.GetRange(1, end - 1)) });
                lines.RemoveRange(0, end + 1);
            }
        }

        blocks.AddRange(ParseBlocks(lines));
        return blocks;
    }

    private static List<MarkdownBlock> ParseBlocks(List<string> lines)
    {
        var blocks = new List<MarkdownBlock>();
        var paragraph = new List<string>();
        void FlushParagraph()
        {
            if (paragraph.Count > 0)
            {
                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Paragraph, Spans = ParseInline(string.Join("\n", paragraph)) });
                paragraph.Clear();
            }
        }

        int index = 0;
        while (index < lines.Count)
        {
            string line = lines[index];
            string trimmed = line.Trim();
            Match match;
            if (trimmed.Length == 0)
            {
                FlushParagraph();
                index++;
            }
            else if (trimmed.StartsWith("```", StringComparison.Ordinal) || trimmed.StartsWith("~~~", StringComparison.Ordinal))
            {
                FlushParagraph();
                string fence = new string(trimmed[0], trimmed.TakeWhile(character => character == trimmed[0]).Count());
                var code = new List<string>();
                index++;
                while (index < lines.Count && !lines[index].Trim().StartsWith(fence, StringComparison.Ordinal))
                {
                    code.Add(lines[index]);
                    index++;
                }

                index++;
                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Code, CodeText = string.Join("\n", code) });
            }
            else if ((match = HeadingPattern.Match(line)).Success)
            {
                FlushParagraph();
                blocks.Add(new MarkdownBlock
                {
                    Kind = MarkdownBlockKind.Heading,
                    HeadingLevel = match.Groups[1].Length,
                    Spans = ParseInline(match.Groups[2].Value),
                });
                index++;
            }
            else if (RulePattern.IsMatch(line))
            {
                FlushParagraph();
                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Rule });
                index++;
            }
            else if (QuotePattern.IsMatch(line))
            {
                FlushParagraph();
                var quoted = new List<string>();
                while (index < lines.Count && (match = QuotePattern.Match(lines[index])).Success)
                {
                    quoted.Add(match.Groups[1].Value);
                    index++;
                }

                // An Obsidian callout shows its title, or its type when it has no title, in bold.
                Match callout = CalloutPattern.Match(quoted[0]);
                if (callout.Success)
                {
                    string type = callout.Groups[1].Value;
                    string title = callout.Groups[2].Value.Trim();
                    quoted[0] = $"**{(title.Length > 0 ? title : char.ToUpperInvariant(type[0]) + type.Substring(1))}**";
                }

                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Quote, Children = ParseBlocks(quoted) });
            }
            else if (ListItemPattern.IsMatch(line))
            {
                FlushParagraph();
                blocks.Add(ParseList(lines, ref index));
            }
            else if (line.Contains('|') && index + 1 < lines.Count && lines[index + 1].Contains('-') && TableSeparatorPattern.IsMatch(lines[index + 1]))
            {
                FlushParagraph();
                blocks.Add(ParseTable(lines, ref index));
            }
            else if ((match = EmbedPattern.Match(trimmed)).Success)
            {
                FlushParagraph();
                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Embed, EmbedTarget = match.Groups[1].Value });
                index++;
            }
            else if ((match = ImagePattern.Match(trimmed)).Success)
            {
                FlushParagraph();
                blocks.Add(new MarkdownBlock { Kind = MarkdownBlockKind.Embed, EmbedTarget = match.Groups[1].Value, EmbedIsPath = true });
                index++;
            }
            else
            {
                paragraph.Add(trimmed);
                index++;
            }
        }

        FlushParagraph();
        return blocks;
    }

    private static MarkdownBlock ParseList(List<string> lines, ref int index)
    {
        Match first = ListItemPattern.Match(lines[index]);
        int indent = IndentWidth(first.Groups[1].Value);
        bool ordered = char.IsDigit(first.Groups[2].Value[0]);
        var list = new MarkdownBlock
        {
            Kind = MarkdownBlockKind.List,
            Ordered = ordered,
            FirstNumber = ordered ? int.Parse(first.Groups[2].Value.TrimEnd('.', ')')) : 0,
            ListItems = new List<List<MarkdownBlock>>(),
        };

        while (index < lines.Count)
        {
            if (lines[index].Trim().Length == 0)
            {
                int next = NextContentLine(lines, index);
                if (next < 0 || !IsSiblingItem(lines[next], indent, ordered))
                {
                    break;
                }

                index = next;
            }

            Match item = ListItemPattern.Match(lines[index]);
            if (!IsSiblingItem(lines[index], indent, ordered))
            {
                break;
            }

            int contentIndent = item.Groups[3].Success ? IndentWidth(lines[index].Substring(0, item.Groups[3].Index)) : indent + item.Groups[2].Length + 1;
            string itemText = item.Groups[3].Value;
            if (itemText.StartsWith("[ ] ", StringComparison.Ordinal))
            {
                itemText = "\u2610 " + itemText.Substring(4);
            }
            else if (itemText.StartsWith("[x] ", StringComparison.OrdinalIgnoreCase))
            {
                itemText = "\u2611 " + itemText.Substring(4);
            }

            var itemLines = new List<string> { itemText };
            index++;
            while (index < lines.Count)
            {
                string line = lines[index];
                if (line.Trim().Length == 0)
                {
                    int next = NextContentLine(lines, index);
                    if (next < 0 || IndentWidth(LeadingWhitespace(lines[next])) <= indent)
                    {
                        break;
                    }

                    itemLines.Add(string.Empty);
                    index++;
                    continue;
                }

                int lineIndent = IndentWidth(LeadingWhitespace(line));
                if (lineIndent <= indent)
                {
                    break;
                }

                itemLines.Add(StripIndent(line, Math.Min(lineIndent, contentIndent)));
                index++;
            }

            list.ListItems.Add(ParseBlocks(itemLines));
        }

        return list;
    }

    private static bool IsSiblingItem(string line, int indent, bool ordered)
    {
        Match item = ListItemPattern.Match(line);
        return item.Success && IndentWidth(item.Groups[1].Value) == indent && char.IsDigit(item.Groups[2].Value[0]) == ordered
            && !RulePattern.IsMatch(line);
    }

    private static int NextContentLine(List<string> lines, int index)
    {
        for (int next = index; next < lines.Count; next++)
        {
            if (lines[next].Trim().Length > 0)
            {
                return next;
            }
        }

        return -1;
    }

    private static string LeadingWhitespace(string line) => line.Substring(0, line.Length - line.TrimStart(' ', '\t').Length);

    private static int IndentWidth(string whitespace) => whitespace.Sum(character => character == '\t' ? 4 : 1);

    private static string StripIndent(string line, int columns)
    {
        int width = 0;
        int position = 0;
        while (position < line.Length && width < columns && (line[position] == ' ' || line[position] == '\t'))
        {
            width += line[position] == '\t' ? 4 : 1;
            position++;
        }

        return line.Substring(position);
    }

    private static MarkdownBlock ParseTable(List<string> lines, ref int index)
    {
        List<string> header = SplitRow(lines[index]);
        var rows = new List<List<List<MarkdownSpan>>>();
        rows.Add(header.Select(ParseInline).ToList());
        index += 2;
        while (index < lines.Count && lines[index].Trim().Length > 0 && lines[index].Contains('|'))
        {
            List<string> cells = SplitRow(lines[index]);
            rows.Add(Enumerable.Range(0, header.Count).Select(column => ParseInline(column < cells.Count ? cells[column] : string.Empty)).ToList());
            index++;
        }

        return new MarkdownBlock { Kind = MarkdownBlockKind.Table, TableRows = rows };
    }

    private static List<string> SplitRow(string line)
    {
        string row = line.Trim();
        if (row.StartsWith("|", StringComparison.Ordinal))
        {
            row = row.Substring(1);
        }

        if (row.EndsWith("|", StringComparison.Ordinal) && !row.EndsWith("\\|", StringComparison.Ordinal))
        {
            row = row.Substring(0, row.Length - 1);
        }

        var cells = new List<string>();
        var cell = new StringBuilder();
        bool inCode = false;
        for (int position = 0; position < row.Length; position++)
        {
            char character = row[position];
            if (character == '`')
            {
                inCode = !inCode;
            }

            if (character == '|' && !inCode && (position == 0 || row[position - 1] != '\\'))
            {
                cells.Add(cell.ToString().Trim());
                cell.Clear();
                continue;
            }

            cell.Append(character);
        }

        cells.Add(cell.ToString().Trim());
        return cells;
    }

    public static List<MarkdownSpan> ParseInline(string text)
    {
        var spans = new List<MarkdownSpan>();
        var buffer = new StringBuilder();
        bool bold = false;
        bool italic = false;
        bool highlight = false;
        void Flush()
        {
            if (buffer.Length > 0)
            {
                spans.Add(new MarkdownSpan { Text = buffer.ToString(), Bold = bold, Italic = italic, Highlight = highlight });
                buffer.Clear();
            }
        }

        void AddLink(string label, string link, bool isWikiLink)
        {
            Flush();
            spans.Add(new MarkdownSpan { Text = label, Bold = bold, Italic = italic, Highlight = highlight, Link = link, IsWikiLink = isWikiLink });
        }

        int position = 0;
        while (position < text.Length)
        {
            char character = text[position];
            Match autoLink;
            if (character == '\\' && position + 1 < text.Length && char.IsPunctuation(text[position + 1]) || character == '\\' && position + 1 < text.Length && char.IsSymbol(text[position + 1]))
            {
                buffer.Append(text[position + 1]);
                position += 2;
            }
            else if (character == '\n')
            {
                Flush();
                spans.Add(new MarkdownSpan { Text = "\n" });
                position++;
            }
            else if (character == '`')
            {
                int run = CountRun(text, position, '`');
                string fence = new string('`', run);
                int close = text.IndexOf(fence, position + run, StringComparison.Ordinal);
                if (close < 0)
                {
                    buffer.Append(fence);
                    position += run;
                    continue;
                }

                Flush();
                string code = text.Substring(position + run, close - position - run);
                if (code.Length > 2 && code[0] == ' ' && code[code.Length - 1] == ' ')
                {
                    code = code.Substring(1, code.Length - 2);
                }

                spans.Add(new MarkdownSpan { Text = code.Replace('\n', ' '), Code = true });
                position = close + run;
            }
            else if (StartsWith(text, position, "[[") || StartsWith(text, position, "![["))
            {
                int start = position + (character == '!' ? 3 : 2);
                int close = text.IndexOf("]]", start, StringComparison.Ordinal);
                if (close < 0)
                {
                    buffer.Append(character);
                    position++;
                    continue;
                }

                string inner = text.Substring(start, close - start).Replace("\\|", "|");
                int aliasSeparator = inner.IndexOf('|');
                string target = aliasSeparator < 0 ? inner : inner.Substring(0, aliasSeparator);
                AddLink(aliasSeparator < 0 ? target : inner.Substring(aliasSeparator + 1), target.Trim(), true);
                position = close + 2;
            }
            else if (character == '[' || character == '!' && StartsWith(text, position, "!["))
            {
                int labelStart = position + (character == '!' ? 2 : 1);
                int labelEnd = text.IndexOf(']', labelStart);
                int urlEnd = labelEnd >= 0 && labelEnd + 1 < text.Length && text[labelEnd + 1] == '(' ? text.IndexOf(')', labelEnd + 2) : -1;
                if (urlEnd < 0)
                {
                    buffer.Append(character);
                    position++;
                    continue;
                }

                string destination = text.Substring(labelEnd + 2, urlEnd - labelEnd - 2).Trim();
                if (destination.StartsWith("<", StringComparison.Ordinal) && destination.Contains('>'))
                {
                    destination = destination.Substring(1, destination.IndexOf('>') - 1);
                }
                else if (destination.Contains(' '))
                {
                    destination = destination.Substring(0, destination.IndexOf(' '));
                }

                string label = text.Substring(labelStart, labelEnd - labelStart);
                AddLink(label.Length > 0 ? label : destination, destination, false);
                position = urlEnd + 1;
            }
            else if (character == '<' && (autoLink = AutoLinkPattern.Match(text, position)).Success)
            {
                AddLink(autoLink.Groups[1].Value, autoLink.Groups[1].Value, false);
                position += autoLink.Length;
            }
            else if (character == 'h' && (position == 0 || !char.IsLetterOrDigit(text[position - 1]))
                && (StartsWith(text, position, "https://") || StartsWith(text, position, "http://")))
            {
                int end = position;
                while (end < text.Length && !char.IsWhiteSpace(text[end]))
                {
                    end++;
                }

                while (end > position && ".,;:!?)".IndexOf(text[end - 1]) >= 0)
                {
                    end--;
                }

                string url = text.Substring(position, end - position);
                AddLink(url, url, false);
                position = end;
            }
            else if (StartsWith(text, position, "==") && (highlight ? position > 0 && !char.IsWhiteSpace(text[position - 1])
                : position + 2 < text.Length && !char.IsWhiteSpace(text[position + 2]) && text.IndexOf("==", position + 3, StringComparison.Ordinal) > 0))
            {
                Flush();
                highlight = !highlight;
                position += 2;
            }
            else if (character == '*' || character == '_')
            {
                int run = Math.Min(CountRun(text, position, character), 3);
                bool intraword = character == '_' && position > 0 && char.IsLetterOrDigit(text[position - 1])
                    && position + run < text.Length && char.IsLetterOrDigit(text[position + run]);
                int width = run >= 2 ? 2 : 1;
                string marker = new string(character, width);
                bool isOpen = width == 2 ? bold : italic;
                bool canOpen = position + width < text.Length && !char.IsWhiteSpace(text[position + width])
                    && text.IndexOf(marker, position + width + 1, StringComparison.Ordinal) > 0;
                if (intraword || !isOpen && !canOpen)
                {
                    buffer.Append(character, run);
                    position += run;
                    continue;
                }

                Flush();
                if (width == 2)
                {
                    bold = !bold;
                }
                else
                {
                    italic = !italic;
                }

                position += width;
            }
            else
            {
                buffer.Append(character);
                position++;
            }
        }

        Flush();
        return spans;
    }

    private static bool StartsWith(string text, int position, string value) => string.CompareOrdinal(text, position, value, 0, value.Length) == 0;

    private static int CountRun(string text, int position, char character)
    {
        int end = position;
        while (end < text.Length && text[end] == character)
        {
            end++;
        }

        return end - position;
    }
}
