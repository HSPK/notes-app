use super::*;

#[test]
fn heading_adapter_preserves_all_other_parser_events() {
    for source in [
        "> ## Quoted **heading**\n>\n> Body.\n\n- Item\n  ### Nested heading\n",
        "# ![image *caption*](img.png) [link](other.md) [^note]\n\n[^note]: Footnote body.\n",
        "Setext `code`\nwith a hard break  \nand more text\n=================\n\n# End\n",
        "# [[Other|Wiki alias]] &amp; <em>HTML</em>\n\n```md\n# Not a heading\n```\n",
        "| Cell | Value |\n| --- | --- |\n| # Text | Content |\n\n- [x] Done\n\n# Heading\n",
    ] {
        let options = Options::ENABLE_TABLES
            | Options::ENABLE_TASKLISTS
            | Options::ENABLE_STRIKETHROUGH
            | Options::ENABLE_FOOTNOTES
            | Options::ENABLE_WIKILINKS;
        let original: Vec<_> = Parser::new_ext(source, options).collect();
        let actual: Vec<_> = heading_events(original.clone().into_iter())
            .map(|event| match event {
                Event::Start(Tag::Heading {
                    level,
                    classes,
                    attrs,
                    ..
                }) => Event::Start(Tag::Heading {
                    level,
                    id: None,
                    classes,
                    attrs,
                }),
                other => other,
            })
            .collect();
        assert_eq!(actual, original, "{source}");
    }
}

#[test]
fn streamed_headings_preserve_ids_inline_order_and_duplicate_collisions() {
    let output = render(
        "guide/note.md",
        "\
# Same
# Same-2
# Same
## **Bold** `code` [linked](Other.md) ![caption](image.png)
## <i>Literal</i> [unsafe](javascript:alert%281%29)

Title *across*
two lines
-------------
",
    );
    for expected in [
        "<h1 id=\"same\">Same</h1>",
        "<h1 id=\"same-2\">Same-2</h1>",
        "<h1 id=\"same-3\">Same</h1>",
        "<h2 id=\"bold-code-linked-caption\"><strong>Bold</strong> <code>code</code> <a href=\"/guide/Other.md\">linked</a> <img src=\"/guide/image.png\" alt=\"caption\" /></h2>",
        "<h2 id=\"literal-unsafe\">&lt;i&gt;Literal&lt;/i&gt; unsafe</h2>",
        "<h2 id=\"title-across-two-lines\">Title <em>across</em>\ntwo lines</h2>",
    ] {
        assert!(output.contains(expected), "missing {expected}: {output}");
    }
}

#[test]
fn heading_character_limit_keeps_full_body_and_unicode_anchor_compatibility() {
    let text = "中".repeat(159);
    let output = render("note.md", &format!("# {text} **文尾**\n\n# !!!\n# !!!\n"));
    assert!(output.contains(&format!("id=\"{text}\"")));
    assert!(output.contains("<strong>文尾</strong>"));
    assert!(output.contains("id=\"section\""));
    assert!(output.contains("id=\"section-2\""));
    let events = [
        Event::Start(Tag::Heading {
            level: pulldown_cmark::HeadingLevel::H2,
            id: None,
            classes: vec![],
            attrs: vec![],
        }),
        Event::Text("中".repeat(60).into()),
        Event::SoftBreak,
        Event::Text("Tail".into()),
        Event::End(TagEnd::Heading(pulldown_cmark::HeadingLevel::H2)),
    ];
    let streamed: Vec<_> = heading_events(events.clone().into_iter()).collect();
    assert_eq!(&streamed[1..], &events[1..]);
    assert!(
        matches!(&streamed[0], Event::Start(Tag::Heading { id: Some(id), .. })
        if id.as_ref() == format!("{}tail", "中".repeat(60)))
    );
}

#[test]
#[ignore = "performance benchmark"]
fn benchmark_markdown_render_pipeline() {
    let samples = [
        (
            "mixed",
            "## Measurement\n\nA paragraph with **formatted text**, [a local link](Other.md), and `inline code`.\n\n".repeat(2700),
        ),
        (
            "unicode-headings",
            format!("# {} `code`\n\nParagraph.\n\n", "中文".repeat(100)).repeat(1500),
        ),
    ];
    for (name, source) in samples {
        let expected = render("Bench.md", &source);
        let mut timings = Vec::new();
        for _ in 0..9 {
            let start = std::time::Instant::now();
            for _ in 0..4 {
                let actual = render(
                    std::hint::black_box("Bench.md"),
                    std::hint::black_box(&source),
                );
                assert_eq!(actual, expected);
                std::hint::black_box(actual);
            }
            timings.push(start.elapsed().as_secs_f64() * 1000.0 / 4.0);
        }
        timings.sort_by(f64::total_cmp);
        println!(
            "{{\"case\":\"{name}\",\"bytes\":{},\"medianMs\":{:.3},\"maxMs\":{:.3}}}",
            source.len(),
            timings[4],
            timings[8]
        );
    }
}
