import { basename, extname, posix, relative, sep } from 'node:path'
import { env } from 'node:process'
import { globSync } from 'glob'
import type { PluginSimple } from 'markdown-it'
import { cyan, gray, yellow } from 'colorette'

import { findBiDirectionalLinks, genImage, genLink } from './utils'

/** it will match [[file]] and [[file|text]] */
const biDirectionalLinkPattern = /\!?\[\[([^|\]\n]+)(\|([^\]\n]+))?\]\](?!\()/
/** it will match [[file]] and [[file|text]] but only at the start of the text */
const biDirectionalLinkPatternWithStart = /^\!?\[\[([^|\]\n]+)(\|([^\]\n]+))?\]\](?!\()/

const IMAGES_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp', '.tiff', '.apng', '.avif', '.jfif', '.pjpeg', '.pjp', '.png', '.svg', '.webp', '.xbm']

function logIncorrectMatchedMarkupWarning(
  input: string,
  src: string,
  path: string,
) {
  const debug = (env?.DEBUG) ?? ''

  if (!debug)
    return

  let shouldLog = false
  if (debug === '@nolebase/*')
    shouldLog = true
  if (debug === '@nolebase/markdown-it-*')
    shouldLog = true
  if (debug === '@nolebase/markdown-it-bi-directional-links')
    shouldLog = true

  if (!shouldLog)
    return

  console.warn(`${cyan(`@nolebase/markdown-it-bi-directional-links`)}${gray(':')} ${yellow('[WARN]')} Matched markup '${input}' is not at the start of the text. ${yellow(`

Things to check:

  1. Is this a expected markup for bi-directional links?
  2. Is there any other markup before this markup?`)}

${yellow('Source text:')}

  ${gray(src)}

  ${gray(`at`)} ${cyan(path)}
`)
}

function logNoMatchedFileWarning(
  inputContent: string,
  markupTextContent: string,
  href: string,
  osSpecificHref: string,
  path: string,
  relevantPath?: { key: string, source: string },
) {
  console.warn(`${cyan(`@nolebase/markdown-it-bi-directional-links`)}${gray(':')} ${yellow('[WARN]')} No matched file found for '${osSpecificHref}', ignored. ${yellow(`

Things to check:

  1. Was the matched most relevant file expected?
    1. Was it renamed during the build process?
    2. Does it exist in the file system with the correct path?
    3. Does it have the correct extension? (Either .md for Markdown files or image extensions)
    4. Does it have the correct case? (Linux is Case-sensitive while macOS isn't)
    5. Does it have any special characters in the file name? (e.g. back slashes, quotes, illegal characters, etc.
  2. If <N/A> was shown, it means no relevant path was found. In such cases:
    1. Check the file system for the file if you expect it to get matched.
    2. Check whether mis-spelling or incorrect path was used in the markup.
  3. If you are using a custom base directory, check whether the base directory is correct.`)}

Matching chain:

  ${gray(inputContent)}
    -> ${gray(markupTextContent)}
      -> ${gray(href)}

${relevantPath ? `The most relevant paths: "${gray(relevantPath.key ?? '<N/A>')} matched by ${relevantPath.source ?? '<N/A>'}"` : ''}

  ${gray('at')} "${cyan(path)}"
`)
}

function findTheMostRelevantOne(
  possibleBiDirectionalLinksInCleanBaseNameOfFilePaths: Record<string, string>,
  possibleBiDirectionalLinksInFullFilePaths: Record<string, string>,
  href: string,
) {
  for (const key in possibleBiDirectionalLinksInCleanBaseNameOfFilePaths) {
    if (key.includes(href)) {
      return {
        key: possibleBiDirectionalLinksInCleanBaseNameOfFilePaths[key],
        source: 'file name',
      }
    }
  }
  for (const key in possibleBiDirectionalLinksInFullFilePaths) {
    if (key.includes(href)) {
      return {
        key: possibleBiDirectionalLinksInFullFilePaths[key],
        source: 'absolute path',
      }
    }
  }
}

/**
 * A markdown-it plugin to support bi-directional links.
 * @param options - Options.
 * @param options.dir - The directory to search for bi-directional links.
 * @param options.baseDir - The base directory joined as href for bi-directional links.
 * @param options.includesPatterns - The glob patterns to search for bi-directional links.
 * @returns A markdown-it plugin.
 */
export const BiDirectionalLinks: (options: {
  dir: string
  baseDir?: string
  includesPatterns?: string[]
}) => PluginSimple = (options) => {
  const rootDir = options.dir
  const includes = options?.includesPatterns ?? []

  const possibleBiDirectionalLinksInCleanBaseNameOfFilePaths: Record<string, string> = {}
  const possibleBiDirectionalLinksInFullFilePaths: Record<string, string> = {}

  if (includes.length === 0) {
    includes.push('**/*.md')
    IMAGES_EXTENSIONS.forEach(ext => includes.push(`**/*${ext}`))
  }

  for (const include of includes) {
    const files = globSync(include, {
      nodir: true,
      absolute: true,
      cwd: rootDir,
      ignore: [
        '_*',
        'dist',
        'node_modules',
      ],
    })

    for (const file of files) {
      const relativeFilePath = relative(rootDir, file)
      const partialFilePathWithOnlyBaseName = basename(relativeFilePath)

      const existingFileName = possibleBiDirectionalLinksInCleanBaseNameOfFilePaths[partialFilePathWithOnlyBaseName]

      // when conflict
      if (typeof existingFileName === 'string' && existingFileName !== '') {
        // remove key from clean base name map
        delete possibleBiDirectionalLinksInCleanBaseNameOfFilePaths[partialFilePathWithOnlyBaseName]
        // remove key from full file path map
        delete possibleBiDirectionalLinksInFullFilePaths[existingFileName]

        // add key to full file path map
        possibleBiDirectionalLinksInFullFilePaths[relativeFilePath] = relativeFilePath
        // recover deleted and conflicted key to full file path map
        possibleBiDirectionalLinksInFullFilePaths[existingFileName] = existingFileName

        continue
      }

      // otherwise, add key to both maps
      possibleBiDirectionalLinksInCleanBaseNameOfFilePaths[partialFilePathWithOnlyBaseName] = relativeFilePath
      possibleBiDirectionalLinksInFullFilePaths[relativeFilePath] = relativeFilePath
    }
  }

  return (md) => {
    md.inline.ruler.after('text', 'bi_directional_link_replace', (state) => {
      const src = state.src.slice(state.pos, state.posMax)
      const link = src.match(biDirectionalLinkPattern)
      if (!link)
        return false

      if (!link.input)
        return false

      // Sometimes the matched markup is not at the start of the text
      // in many scenarios, e.g.:
      // 1. `[[file]]` is matched but it is not at the start of the text, but [[file]] will be valid without quotes
      // 2. `[[file|text]]` is matched but it is not at the start of the text, but [[file|text]] will be valid without quotes
      //
      // For such cases, we will log a warning and ignore the matched markup
      // If user would like to see the warning, they can enable debug mode
      // by setting `DEBUG=@nolebase/markdown-it-bi-directional-links` in the environment variable
      // or by setting `import.meta.env.DEBUG = '@nolebase/markdown-it-bi-directional-links'` in the script.
      if (!biDirectionalLinkPatternWithStart.exec(link.input)) {
        logIncorrectMatchedMarkupWarning(link.input, src, state.env.path)
        return false
      }

      const isAttachmentRef = link.input.startsWith('!')

      const inputContent = link.input
      const markupTextContent = link[0]
      const href = link[1] // href is the file name, uses posix style
      const text = link[3] ?? ''

      const isImageRef = isAttachmentRef && IMAGES_EXTENSIONS.some(ext => href.endsWith(ext))

      // Convert href to os specific path for matching and resolving
      let osSpecificHref = href.split('/').join(sep)

      // if osSpecificHref has no extension, suffix it with .md
      if (!isImageRef && (extname(osSpecificHref) === '' || extname(osSpecificHref) !== '.md'))
        osSpecificHref += '.md'

      const matchedHref = findBiDirectionalLinks(possibleBiDirectionalLinksInCleanBaseNameOfFilePaths, possibleBiDirectionalLinksInFullFilePaths, osSpecificHref)
      if (!matchedHref) {
        const relevantPath = findTheMostRelevantOne(possibleBiDirectionalLinksInCleanBaseNameOfFilePaths, possibleBiDirectionalLinksInFullFilePaths, osSpecificHref)
        logNoMatchedFileWarning(inputContent, markupTextContent, href, osSpecificHref, state.env.path, relevantPath)

        return false
      }

      const resolvedNewHref = posix.join(options.baseDir ?? '/', relative(rootDir, matchedHref).split(sep).join('/'))

      if (isImageRef)
        genImage(state, resolvedNewHref, text, link)
      else
        genLink(state, resolvedNewHref, text, md, href, link)

      return true
    })
  }
}
