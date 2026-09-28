/** 把 docParse.ts 切出来的块画成 React 节点。文本只当文本渲染(React 默认转义)。 */
import { Fragment, useMemo } from 'react';
import { parseDoc, type Inline } from './docParse';

function Text({ inline }: { inline: Inline[] }) {
  return (
    <>
      {inline.map((part, i) => (part.bold ? <b key={i}>{part.text}</b> : <Fragment key={i}>{part.text}</Fragment>))}
    </>
  );
}

export function PlainDoc({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseDoc(text), [text]);
  return (
    <div className={`plain-doc selectable${className ? ` ${className}` : ''}`}>
      {blocks.map((block, i) => {
        if (block.kind === 'heading') {
          const Tag = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
          return (
            <Tag key={i}>
              <Text inline={block.inline} />
            </Tag>
          );
        }
        if (block.kind === 'list') {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>
                  <Text inline={item} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'table') {
          return (
            <table key={i}>
              <thead>
                <tr>
                  {block.head.map((cell, j) => (
                    <th key={j}>
                      <Text inline={cell} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j}>
                    {row.map((cell, k) => (
                      <td key={k}>
                        <Text inline={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        return (
          <p key={i}>
            <Text inline={block.inline} />
          </p>
        );
      })}
    </div>
  );
}
