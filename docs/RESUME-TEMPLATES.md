# Resume templates

Iris fills a LaTeX resume for every job. It uses the built-in **Classic** template, or your own
LaTeX file (Settings → Jobs → Resume template → *Use my LaTeX resume…*).

## Your own resume, read automatically

Iris recognises these layouts and marks them up by itself:

| Layout | How entries look |
| --- | --- |
| Jake's resume / sb2nov | `\resumeSubheading{…}{…}{…}{…}` with `\resumeItem{…}` bullets, `\textbf{Group}{: a, b}` skills |
| Awesome-CV | `\cvsection{…}`, `\cventry{title}{org}{place}{dates}{\begin{cvitems}\item{…}\end{cvitems}}`, `\cvskill{Group}{a, b}` |
| moderncv | `\section{…}`, `\cventry{dates}{title}{employer}{city}{}{\begin{itemize}\item …\end{itemize}}`, `\cvitem{Group}{a, b}` |
| similar ones | any section whose entries all start with the same command of 2+ arguments, bullets as one-argument commands or `\item` lines |

Your header (name, contact line, photo) and every section Iris does not know (Leadership, Volunteering,
…) stay exactly as you wrote them. After importing, Settings lists each section as **filled in for each
job** or **kept as you wrote it**. Iris checks its work: each section it marks up, refilled with your own
content, must read the same as before — otherwise it leaves that section alone.

## Marking a template by hand

If a section is "kept as you wrote it" and you want Iris to fill it, add markers. They are LaTeX
comments, so your file still compiles on its own. Edit `template.tex` (Settings → *Show template*).

```latex
%%IRIS:if experience
\section{Experience}
\begin{itemize}
%%IRIS:each experience
\item \textbf{<<title>>} at <<company>> \hfill <<dates>> \\ <<location?>>
%%IRIS:if bullets
  \begin{itemize}
%%IRIS:each bullets
    \item <<text>>
%%IRIS:end bullets
  \end{itemize}
%%IRIS:endif bullets
%%IRIS:end experience
\end{itemize}
%%IRIS:endif experience
```

| Marker | Meaning |
| --- | --- |
| `%%IRIS:if X` … `%%IRIS:endif X` | dropped when there is nothing to show for X |
| `%%IRIS:each X` … `%%IRIS:end X` | repeated for every entry of X |
| `%%IRIS:each skills join=\\` | entries joined by a LaTeX line break |
| `<<field>>` | a value, escaped for LaTeX |
| `<<field?>>` | optional: the whole line goes when the value is empty |

Lists and their fields:

- `experience`: `title`, `company`, `location`, `dates`, `bullets` (each: `text`)
- `projects`: `name`, `tech`, `link`, `dates`, `bullets`
- `education`: `school`, `degree`, `location`, `dates`, `details` (each: `text`)
- `skills`: `group`, `items` (comma-separated)
- `extras`: `text`
- top level: `summary`, `name`, `contact` (the built-in contact line)

Iris keeps the PDF to exactly one page: it builds it, measures how full the page is, and removes or adds
bullets until it fits.
