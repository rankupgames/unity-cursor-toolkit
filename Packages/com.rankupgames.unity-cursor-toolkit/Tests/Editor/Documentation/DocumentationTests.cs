using System;
using System.IO;
using System.Reflection;
using NUnit.Framework;
using UnityEditor;
using UnityEngine;

public sealed class DocumentationTests
{
    private ExcalidrawDrawing _drawing;

    [SetUp]
    public void SetUp() => _drawing = ScriptableObject.CreateInstance<ExcalidrawDrawing>();

    [TearDown]
    public void TearDown() => UnityEngine.Object.DestroyImmediate(_drawing);

    private static object Invoke(Type owner, string method, Type[] types, params object[] arguments) =>
        owner.GetMethod(method, BindingFlags.NonPublic | BindingFlags.Static, null, types, null).Invoke(null, arguments);

    private void ParseDrawing(string json) => Invoke(typeof(ExcalidrawImporter), "Parse",
        new[] { typeof(string), typeof(ExcalidrawDrawing) }, json, _drawing);

    [TestCase("{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"a\",\"type\":\"rectangle\",\"x\":0,\"y\":0,\"width\":-1,\"height\":1}]}")]
    [TestCase("{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"a\",\"type\":\"rectangle\",\"x\":1e1000,\"y\":0,\"width\":1,\"height\":1}]}")]
    [TestCase("{\"type\":\"excalidraw\",\"elements\":[{\"type\":\"rectangle\"}]}")]
    [TestCase("{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"a\",\"type\":\"rectangle\"}]}")]
    [TestCase("{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"a\",\"type\":\"text\",\"isDeleted\":true},{\"id\":\"a\",\"type\":\"text\",\"isDeleted\":true}]}")]
    [TestCase("{\"type\":\"excalidraw\",\"elements\":[],\"elements\":[]}")]
    [TestCase("{\"type\":\"excalidraw\",\"elements\":\"bad\"}")]
    public void MalformedDrawingsFail(string json) => Assert.Throws<TargetInvocationException>(() => ParseDrawing(json));

    [Test]
    public void DrawingBoundsIncludeNegativeLinePoints()
    {
        ParseDrawing("{\"type\":\"excalidraw\",\"elements\":[{\"id\":\"line\",\"type\":\"line\",\"x\":40,\"y\":50,\"width\":20,\"height\":30,\"points\":[[0,0],[-20,-30]]}]}");
        Assert.AreEqual(1, _drawing.Elements.Count);
        Assert.AreEqual(new Rect(20, 20, 20, 30), _drawing.ContentBounds);
    }

    [TestCase("{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":\"a\",\"x\":0,\"y\":0,\"width\":1,\"height\":1},{\"id\":\"a\",\"type\":\"text\",\"text\":\"b\",\"x\":0,\"y\":0,\"width\":1,\"height\":1}],\"edges\":[]}")]
    [TestCase("{\"nodes\":[{\"id\":\"a\",\"type\":\"text\",\"text\":false,\"x\":0,\"y\":0,\"width\":1,\"height\":1}],\"edges\":[]}")]
    [TestCase("{\"nodes\":[],\"edges\":[{\"id\":\"a\",\"fromNode\":\"missing\",\"toNode\":\"missing\"}]}")]
    [TestCase("{\"nodes\":\"bad\",\"edges\":[]}")]
    public void MalformedCanvasesFail(string json) => Assert.Throws<TargetInvocationException>(() =>
        Invoke(typeof(ObsidianCanvasImporter), "Parse", new[] { typeof(string), typeof(ExcalidrawDrawing), typeof(string), typeof(Action<string>) },
            json, _drawing, "Assets/fixture.canvas", new Action<string>(_ => { })));

    [Test]
    public void CanvasArraysMayBeOmitted()
    {
        Invoke(typeof(ObsidianCanvasImporter), "Parse", new[] { typeof(string), typeof(ExcalidrawDrawing), typeof(string), typeof(Action<string>) },
            "{}", _drawing, "Assets/fixture.canvas", new Action<string>(_ => Assert.Fail("An empty canvas has no dependencies.")));
        Assert.IsEmpty(_drawing.Elements);
    }

    [TestCase("Assets/Docs", "../image.png", "Assets", "Assets/image.png")]
    [TestCase("Packages/example/Docs", "../image.png", "Packages/example", "Packages/example/image.png")]
    [TestCase("Assets", "../secret", "Assets", null)]
    [TestCase("Packages/example", "../other/file", "Packages/example", null)]
    [TestCase("Assets", "/private/file", "Assets", null)]
    [TestCase("Assets", "C:\\private\\file", "Assets", null)]
    [TestCase("Assets", "\\\\server\\file", "Assets", null)]
    public void LinksStayInsideTheirRoot(string folder, string link, string root, string expected)
    {
        Type paths = typeof(ExcalidrawDrawing).Assembly.GetType("MarkdownInspector", true);
        Assert.AreEqual(expected, Invoke(paths, "CombineInRoot", new[] { typeof(string), typeof(string), typeof(string) }, folder, link, root));
    }

    [Test]
    public void SourcePathResolvesTheInstalledPackage()
    {
        string script = AssetDatabase.GetAssetPath(MonoScript.FromScriptableObject(_drawing));
        Type paths = typeof(ExcalidrawDrawing).Assembly.GetType("MarkdownInspector", true);
        string physical = (string)Invoke(paths, "SourcePath", new[] { typeof(string) }, script);
        Assert.IsTrue(File.ReadAllText(physical).Contains("class ExcalidrawDrawing"));
        Assert.Throws<TargetInvocationException>(() => Invoke(paths, "SourcePath", new[] { typeof(string) }, "Assets/../outside.txt"));
    }

    [Test]
    public void MarkdownKeepsIncompleteMarkupAsText()
    {
        var blocks = MarkdownParser.Parse("# Title\n\n[unfinished](\n\n```cs\nvar x = 1;\n");
        Assert.AreEqual(MarkdownBlockKind.Heading, blocks[0].Kind);
        Assert.AreEqual("Title", blocks[0].Spans[0].Text);
        Assert.AreEqual("[unfinished](", blocks[1].Spans[0].Text);
        Assert.AreEqual(MarkdownBlockKind.Code, blocks[2].Kind);
        StringAssert.Contains("var x = 1;", blocks[2].CodeText);
    }
}
