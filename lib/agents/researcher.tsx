import { createStreamableUI, createStreamableValue } from 'ai/rsc'
import {
  ExperimentalMessage,
  ToolCallPart,
  ToolResultPart,
  experimental_streamText
} from 'ai'
import { searchSchema } from '@/lib/schema/search'
import { Section } from '@/components/section'
import { OpenAI } from '@ai-sdk/openai'
import { ToolBadge } from '@/components/tool-badge'
import { SearchSkeleton } from '@/components/search-skeleton'
import { SearchResults } from '@/components/search-results'
import { BotMessage } from '@/components/message'
import Exa from 'exa-js'
import { SearchResultsImageSection } from '@/components/search-results-image'
import { Card } from '@/components/ui/card'

export async function researcher(
  uiStream: ReturnType<typeof createStreamableUI>,
  streamText: ReturnType<typeof createStreamableValue<string>>,
  messages: ExperimentalMessage[],
  useSpecificModel?: boolean
) {
  const userInput =
    JSON.parse(
      typeof messages?.[0]?.content === 'string' ? messages?.[0]?.content : '{}'
    )?.input || ''

  const openai = new OpenAI({
    baseUrl: process.env.OPENAI_API_BASE, // optional base URL for proxies etc.
    apiKey: process.env.OPENAI_API_KEY, // optional API key, default to env property OPENAI_API_KEY
    organization: '' // optional organization
  })

  const searchAPI: 'tavily' | 'exa' = 'tavily'

  let fullResponse = ''
  let hasError = false
  const answerSection = (
    <Section title="Answer">
      <BotMessage content={streamText.value} />
    </Section>
  )
  const { products: allProducts } = await shopifyProduct(userInput, 20)
  // As a professional search expert, you possess the ability to search for any information on the web.
  // For each user query, utilize the search results to their fullest potential to provide additional information and assistance in your response.
  //Aim to directly address the user's question, augmenting your response with insights gleaned from the search results.
  const allShopifyProducts =
    allProducts?.edges
      ?.map((x: any) => ({
        productTitle: x.node.title,
        onlineStoreUrl: x.node.onlineStoreUrl,
        productImage: x.node.featuredImage?.url,
        productPrice: x.node.priceRangeV2?.minVariantPrice?.amount,
        productDescription: x.node.description
      }))
      .filter((x: any) => x?.onlineStoreUrl?.length) || []

  const result = await experimental_streamText({
    model: openai.chat(process.env.OPENAI_API_MODEL || 'gpt-4-turbo'),
    maxTokens: 2500,
    system: `
    Act as a store help desk and fulfill the users queries, User will ask questions about the products, Here is your inventory and it is array of hashes: ${allShopifyProducts}
    On every query look for the product that lies in the users filter from the inventory, if no product lies in the filters, then suggest the similar, relevent products.
    If there are any images relevant to your answer, be sure to include them as well.
    Whenever quoting or referencing information from a specific URL, always cite the source URL explicitly.
    Please match the language of the response to the user's language.
    `,
    messages,
    tools: {
      search: {
        description: 'Search the web for information',
        parameters: searchSchema,
        execute: async ({
          query,
          max_results,
          search_depth
        }: {
          query: string
          max_results: number
          search_depth: 'basic' | 'advanced'
        }) => {
          uiStream.update(
            <Section>
              <ToolBadge tool="search">{`${query}`}</ToolBadge>
            </Section>
          )

          uiStream.append(
            <Section>
              <SearchSkeleton />
            </Section>
          )

          // Tavily API requires a minimum of 5 characters in the query
          const filledQuery =
            query.length < 5 ? query + ' '.repeat(5 - query.length) : query
          // let searchResult
          let shopifyProducts
          try {
            const { products } = await shopifyProduct(filledQuery)
            shopifyProducts =
              products?.edges
                ?.map((x: any) => x.node)
                .filter((x: any) => x.onlineStoreUrl?.length) || []
            // console.log('P'.repeat(1000))
            // console.log(shopifyProducts)
            // console.log(messages)
            // console.log(query)

            // searchResult =
            //   searchAPI === 'tavily'
            //     ? await tavilySearch(filledQuery, max_results, search_depth)
            //     : await exaSearch(query)
            // console.log(searchResult)
          } catch (error) {
            console.error('Search API error:', error)
            hasError = true
          }

          if (hasError) {
            fullResponse += `\nAn error occurred while searching for "${query}.`
            uiStream.update(
              <Card className="p-4 mt-2 text-sm">
                {`An error occurred while searching for "${query}".`}
              </Card>
            )
            return shopifyProducts
          }

          uiStream.update(
            <Section title="Images">
              <SearchResultsImageSection
                // images={searchResult.images}
                images={shopifyProducts.map((x: any) => x.featuredImage?.url)}
                // query={searchResult.query}
                query={shopifyProducts.map((x: any) => x.title)}
              />
            </Section>
          )
          uiStream.append(
            <Section title="Sources">
              <SearchResults
                results={shopifyProducts.map((x: any) => ({
                  title: x.title,
                  content: x.description,
                  url: x.onlineStoreUrl
                }))}
              />
              {/* <SearchResults results={searchResult.results} /> */}
            </Section>
          )

          // Append the answer section if the specific model is not used
          if (!useSpecificModel) {
            uiStream.append(answerSection)
          }

          return shopifyProducts
        }
      }
    }
  })
  const toolCalls: ToolCallPart[] = []
  const toolResponses: ToolResultPart[] = []
  for await (const delta of result.fullStream) {
    switch (delta.type) {
      case 'text-delta':
        if (delta.textDelta) {
          // If the first text delata is available, add a ui section
          if (fullResponse.length === 0 && delta.textDelta.length > 0) {
            // Update the UI
            uiStream.update(answerSection)
          }

          fullResponse += delta.textDelta
          streamText.update(fullResponse)
        }
        break
      case 'tool-call':
        toolCalls.push(delta)
        break
      case 'tool-result':
        toolResponses.push(delta)
        break
      case 'error':
        hasError = true
        fullResponse += `\nError occurred while executing the tool`
        break
    }
  }
  messages.push({
    role: 'assistant',
    content: [{ type: 'text', text: fullResponse }, ...toolCalls]
  })

  if (toolResponses.length > 0) {
    // Add tool responses to the messages
    messages.push({ role: 'tool', content: toolResponses })
  }

  return { result, fullResponse, hasError, toolResponses }
}

// async function tavilySearch(
//   query: string,
//   maxResults: number = 10,
//   searchDepth: 'basic' | 'advanced' = 'basic'
// ): Promise<any> {
//   const apiKey = process.env.TAVILY_API_KEY
//   const response = await fetch('https://api.tavily.com/search', {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json'
//     },
//     body: JSON.stringify({
//       api_key: apiKey,
//       query,
//       max_results: maxResults < 5 ? 5 : maxResults,
//       search_depth: searchDepth,
//       include_images: true,
//       include_answers: true
//     })
//   })

//   if (!response.ok) {
//     throw new Error(`Error: ${response.status}`)
//   }

//   const data = await response.json()
//   return data
// }

async function shopifyProduct(search: string, limit: number = 10) {
  let searchString = 'query:"status:active"'
  if (search.length)
    searchString = `query:"(${search
      .toLowerCase()
      ?.replace('tv', 'lcd led')
      ?.split(' ')
      ?.map(x => `title:${toSingular(x)}*`)
      ?.join(' OR ')}) AND status:active"`

  console.log('query ==>>>>>>', searchString)
  const query = `
  {
    products(first: ${limit}, ${searchString} ) {
      edges {
        node {
          id
          title
          handle
          onlineStoreUrl
					featuredImage{
            url
          }
          description
          priceRangeV2 {
            minVariantPrice {
              amount
            }
          }
        }
      }
    }
  }
  `

  function toSingular(word: string) {
    word = word.toLowerCase()
    const rules = [
      { regex: /ies$/, replacement: 'y' },
      { regex: /s$/, replacement: '' }
    ]
    for (let rule of rules) {
      if (rule.regex.test(word)) {
        return word.replace(rule.regex, rule.replacement)
      }
    }
    return word
  }

  const headers = new Headers()
  headers.append(
    'X-Shopify-Access-Token',
    process.env.SHOPIFY_API_ACCESS_TOKEN || ''
  )
  headers.append('Content-Type', 'application/json')

  const response = await fetch(
    `https://${process.env.SHOP_NAME}.myshopify.com/admin/api/2024-04/graphql.json`,
    {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ query })
    }
  )

  if (!response.ok) {
    throw new Error(`Error: ${response.status}`)
  }

  const { data } = await response.json()
  return data
}

async function exaSearch(query: string, maxResults: number = 10): Promise<any> {
  const apiKey = process.env.EXA_API_KEY
  const exa = new Exa(apiKey)
  return exa.searchAndContents(query, {
    highlights: true,
    numResults: maxResults
  })
}
