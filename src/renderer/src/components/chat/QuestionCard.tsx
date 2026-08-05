import { useState } from 'react'
import { HelpCircle } from 'lucide-react'
import type { PendingQuestion } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'

/**
 * A question the agent is blocked on, and the answer.
 *
 * Lives outside ChatPanel because chat is not the only place a turn can run: a
 * tool's button starts one in the tool's own session, and a question raised there
 * appeared nowhere at all — the tool sat spinning on an answer the user was never
 * asked for. Wherever a turn can run, this has to be renderable.
 *
 * Answering is a prop rather than a reach into the store, because a popped-out tool
 * window is a separate document with no store bootstrapped in it.
 */
export function QuestionCard({
  question,
  onAnswer
}: {
  question: PendingQuestion
  onAnswer: (id: string, answer: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/8 px-3 py-2.5">
      <p className="flex items-start gap-2 text-[13px] font-medium text-foreground text-pretty">
        <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-primary" />
        {question.question}
      </p>

      {question.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <Button
              key={option}
              size="xs"
              variant="outline"
              onClick={() => onAnswer(question.id, option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}

      {question.allowFreeText && (
        <div className="mt-2 flex gap-1.5">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                if (draft.trim()) onAnswer(question.id, draft.trim())
              }
            }}
            rows={1}
            placeholder={question.options.length > 0 ? 'Or say something else…' : 'Your answer…'}
            className="min-h-9 text-[13px]"
          />
          <Button
            size="sm"
            disabled={!draft.trim()}
            onClick={() => onAnswer(question.id, draft.trim())}
          >
            Reply
          </Button>
        </div>
      )}
    </div>
  )
}
