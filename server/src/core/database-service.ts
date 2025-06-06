import { QdrantClient } from '@qdrant/js-client-rest';
import dotenv from 'dotenv';
import { FallbackService } from './fallback-service';
import { DocumentChunk } from '../services/chunking';
import { v4 as uuidv4 } from 'uuid';

// Load environment variables
dotenv.config();

// Configuration constants
const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY;
const COLLECTION_NAME = process.env.COLLECTION_NAME || 'knowledge_base';
const VECTOR_SIZE = parseInt(process.env.GEMINI_VECTOR_SIZE || '768', 10); // Gemini embedding size

// In-memory storage for fallback when Qdrant is not available
const inMemoryDocuments = new Map<string, { document: DocumentChunk }>();

// Search result interface with scores
export interface SearchResult {
  id: string;
  documentName: string;
  content: string;
  enhancedContent?: string;
  title?: string;
  summary?: string;
  sourceFile?: string;
  domains?: string[];
  score: number;
}

// Database service class
export class DatabaseService {
  private qdrantClient: QdrantClient;
  private fallbackService: FallbackService;
  
  constructor() {
    this.qdrantClient = new QdrantClient({ 
      url: QDRANT_URL,
      apiKey: QDRANT_API_KEY
    });
    this.fallbackService = new FallbackService('Qdrant');
    console.log(`Initializing database service with Qdrant at ${QDRANT_URL}`);
  }
  
  // Initialize Qdrant and create collections if they don't exist
  public async initialize(): Promise<void> {
    try {
      // Check if collections exist
      const collections = await this.qdrantClient.getCollections();
      
      // Check if the knowledge base collection exists
      const collectionExists = collections.collections?.some(
        (collection) => collection.name === COLLECTION_NAME
      );
      
      if (!collectionExists) {
        console.log(`Creating Qdrant collection: ${COLLECTION_NAME} with vector size: ${VECTOR_SIZE}`);
        
        // Create knowledge base collection
        await this.qdrantClient.createCollection(COLLECTION_NAME, {
          vectors: {
            size: VECTOR_SIZE,
            distance: 'Cosine'
          }
        });
        
        // Create relevant payload indices for knowledge base
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'documentName',
          field_schema: 'keyword'
        });
        
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'title',
          field_schema: 'keyword'
        });
        
        await this.qdrantClient.createPayloadIndex(COLLECTION_NAME, {
          field_name: 'domains',
          field_schema: 'keyword'
        });
      }
      
      this.fallbackService.resetWarningFlag('initialize');
      console.log('Qdrant initialized successfully');
    } catch (error) {
      this.fallbackService.handleError('initialize', error);
    }
  }
  
  // Add documents to knowledge base
  public async addDocumentChunks(documents: DocumentChunk[]): Promise<void> {
    return this.fallbackService.withFallback(
      'addDocumentChunks',
      // Fallback function
      () => {
        for (const doc of documents) {
          inMemoryDocuments.set(doc.id, { document: doc });
        }
      },
      // Qdrant function
      async () => {
        if (documents.length === 0) return;
        
        // Prepare points for bulk insertion
        const points = documents.map(doc => {
          return {
            id: uuidv4(),
            vector: doc.embedding,
            payload: {
              id: doc.id,
              documentName: doc.documentName,
              content: doc.content,
              enhancedContent: doc.enhancedContent,
              title: doc.title,
              summary: doc.summary,
              sourceFile: doc.sourceFile,
              domains: doc.domains
            }
          };
        });
        
        // Insert documents
        await this.qdrantClient.upsert(COLLECTION_NAME, {
          wait: true,
          points
        });
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Helper function to calculate cosine similarity for in-memory fallback
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    
    let dotProduct = 0;
    let aMagnitude = 0;
    let bMagnitude = 0;
    
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      aMagnitude += a[i] * a[i];
      bMagnitude += b[i] * b[i];
    }
    
    aMagnitude = Math.sqrt(aMagnitude);
    bMagnitude = Math.sqrt(bMagnitude);
    
    if (aMagnitude === 0 || bMagnitude === 0) return 0;
    return dotProduct / (aMagnitude * bMagnitude);
  }

  // Search for documents using vector similarity
  public async searchByVector(queryVector: number[], limit = 10): Promise<SearchResult[]> {
    return this.fallbackService.withFallback(
      'searchByVector',
      // Fallback function
      () => {
        // Search documents
        return Array.from(inMemoryDocuments.values())
          .map(item => {
            const doc = item.document;
            return {
              id: doc.id,
              documentName: doc.documentName,
              content: doc.content,
              enhancedContent: doc.enhancedContent,
              title: doc.title,
              summary: doc.summary,
              sourceFile: doc.sourceFile,
              domains: doc.domains,
              score: this.cosineSimilarity(queryVector, doc.embedding)
            };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      },
      // Qdrant function
      async () => {
        const results = await this.qdrantClient.search(COLLECTION_NAME, {
          vector: queryVector,
          limit: limit,
          with_payload: true
        });
        
        return results.map(hit => {
          const payload = hit.payload as any;
          
          return {
            id: payload.id,
            documentName: payload.documentName,
            content: payload.content,
            enhancedContent: payload.enhancedContent,
            title: payload.title,
            summary: payload.summary,
            sourceFile: payload.sourceFile,
            domains: payload.domains || ['default'],
            score: hit.score
          };
        });
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Check if a transcript already exists for a specific videoId
  public async doesTranscriptExist(videoId: string): Promise<boolean> {
    const idPattern = `youtube_${videoId}`;
    
    return this.fallbackService.withFallback(
      'doesTranscriptExist',
      // Fallback function
      () => {
        // Search in-memory documents for the videoId in the id field
        return Array.from(inMemoryDocuments.values())
          .some(item => {
            const doc = item.document;
            return doc.id.startsWith(idPattern);
          });
      },
      // Qdrant function
      async () => {
        // Search for documents with an ID that starts with the pattern
        const filter = {
          must: [
            {
              key: 'id',
              match: {
                text: idPattern,
                exact: false // Using non-exact match to find IDs that start with this pattern
              }
            }
          ]
        };
        
        try {
          // Try with count first as it's more efficient
          const countResponse = await this.qdrantClient.count(COLLECTION_NAME, { filter });
          return countResponse.count > 0;
        } catch (error) {
          console.error('Error checking transcript existence with count:', error);
          
          // Alternative approach if count with text matching doesn't work
          try {
            // Use scroll to check if any documents match
            const results = await this.qdrantClient.scroll(COLLECTION_NAME, {
              filter,
              limit: 1,
              with_payload: true
            });
            
            return results.points.length > 0;
          } catch (scrollFilterError) {
            console.error('Error with filter scroll check:', scrollFilterError);
            
            // Last resort: get first few results and check client-side
            try {
              const allResults = await this.qdrantClient.scroll(COLLECTION_NAME, {
                limit: 100, // Reasonable limit to check
                with_payload: true
              });
              
              // Check if any document ID starts with the pattern
              return allResults.points.some(point => {
                const payload = point.payload as any;
                return payload.id && payload.id.startsWith(idPattern);
              });
            } catch (scrollError) {
              console.error('Error with fallback scroll check:', scrollError);
              return false;
            }
          }
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Delete YouTube video transcript chunks
  public async deleteYoutubeTranscriptChunks(videoId: string): Promise<number> {
    const idPattern = `youtube_${videoId}`;
    
    return this.fallbackService.withFallback(
      'deleteYoutubeTranscriptChunks',
      // Fallback function
      () => {
        let deletedCount = 0;
        // Filter out documents from the specified YouTube video
        Array.from(inMemoryDocuments.keys()).forEach(key => {
          const doc = inMemoryDocuments.get(key)?.document;
          if (doc && doc.id.startsWith(idPattern)) {
            inMemoryDocuments.delete(key);
            deletedCount++;
          }
        });
        return deletedCount;
      },
      // Qdrant function
      async () => {
        try {
          const filter = {
            must: [
              {
                key: 'id',
                match: {
                  text: idPattern,
                  exact: false // Using non-exact match to find IDs that start with this pattern
                }
              }
            ]
          };
          
          // First, count how many chunks will be deleted
          const countResponse = await this.qdrantClient.count(COLLECTION_NAME, { filter });
          const count = countResponse.count;
          
          if (count === 0) {
            return 0;
          }
          
          // Then delete the chunks
          await this.qdrantClient.delete(COLLECTION_NAME, {
            filter,
            wait: true
          });
          
          return count;
        } catch (error) {
          console.error(`Error deleting YouTube video chunks: ${error}`);
          
          // Fallback approach if text matching doesn't work
          try {
            // First get all chunks that match our criteria
            let chunksToDelete: string[] = [];
            let nextPageOffset: string | undefined;
            const limit = 100;
            
            do {
              const response = await this.qdrantClient.scroll(COLLECTION_NAME, {
                with_payload: true,
                limit,
                offset: nextPageOffset,
              });
              
              response.points.forEach(point => {
                const payload = point.payload as any;
                if (payload.id && payload.id.startsWith(idPattern)) {
                  chunksToDelete.push(String(point.id));
                }
              });
              
              nextPageOffset = response.next_page_offset as string | undefined;
            } while (nextPageOffset);
            
            if (chunksToDelete.length === 0) {
              return 0;
            }
            
            // Delete in batches to avoid request size limits
            const batchSize = 100;
            let deletedCount = 0;
            
            for (let i = 0; i < chunksToDelete.length; i += batchSize) {
              const batch = chunksToDelete.slice(i, i + batchSize);
              await this.qdrantClient.delete(COLLECTION_NAME, {
                points: batch,
                wait: true
              });
              deletedCount += batch.length;
            }
            
            return deletedCount;
          } catch (fallbackError) {
            console.error('Error with fallback deletion approach:', fallbackError);
            throw error;
          }
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Count YouTube video transcript chunks without deleting them
  public async countYoutubeTranscriptChunks(videoId: string): Promise<number> {
    const idPattern = `youtube_${videoId}`;
    
    return this.fallbackService.withFallback(
      'countYoutubeTranscriptChunks',
      // Fallback function
      () => {
        let count = 0;
        // Count documents from the specified YouTube video
        Array.from(inMemoryDocuments.values()).forEach(item => {
          const doc = item.document;
          if (doc && doc.id.startsWith(idPattern)) {
            count++;
          }
        });
        return count;
      },
      // Qdrant function
      async () => {
        try {
          const filter = {
            must: [
              {
                key: 'id',
                match: {
                  text: idPattern,
                  exact: false // Using non-exact match to find IDs that start with this pattern
                }
              }
            ]
          };
          
          // Count how many chunks exist
          const countResponse = await this.qdrantClient.count(COLLECTION_NAME, { filter });
          return countResponse.count;
        } catch (error) {
          console.error(`Error counting YouTube video chunks: ${error}`);
          
          // Fallback to client-side filtering if text matching doesn't work
          try {
            let count = 0;
            let nextPageOffset: string | undefined;
            const limit = 100;
            
            do {
              const response = await this.qdrantClient.scroll(COLLECTION_NAME, {
                with_payload: true,
                limit,
                offset: nextPageOffset,
              });
              
              response.points.forEach(point => {
                const payload = point.payload as any;
                if (payload.id && payload.id.startsWith(idPattern)) {
                  count++;
                }
              });
              
              nextPageOffset = response.next_page_offset as string | undefined;
            } while (nextPageOffset);
            
            return count;
          } catch (scrollError) {
            console.error('Error with fallback scroll count:', scrollError);
            throw error;
          }
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }

  // Get all unique document names in the database
  public async getUniqueDocumentNames(): Promise<string[]> {
    return this.fallbackService.withFallback(
      'getUniqueDocumentNames',
      // Fallback function
      () => {
        const documentNames = new Set<string>();
        
        // Collect unique document names from in-memory storage
        Array.from(inMemoryDocuments.values()).forEach(item => {
          if (item.document.documentName) {
            documentNames.add(item.document.documentName);
          }
        });
        
        return Array.from(documentNames);
      },
      // Qdrant function
      async () => {
        try {
          // We need to scroll through all documents to get unique document names
          // Note: This is not the most efficient solution for large collections
          // In a production environment, consider using a separate index or database
          
          const documentNames = new Set<string>();
          let nextPageOffset: string | undefined;
          const limit = 100;
          
          do {
            const response = await this.qdrantClient.scroll(COLLECTION_NAME, {
              with_payload: { include: ['documentName'] },
              limit,
              offset: nextPageOffset,
            });
            
            response.points.forEach(point => {
              const payload = point.payload as any;
              if (payload.documentName) {
                documentNames.add(payload.documentName);
              }
            });
            
            nextPageOffset = response.next_page_offset as string | undefined;
          } while (nextPageOffset);
          
          return Array.from(documentNames);
        } catch (error) {
          console.error('Error getting unique document names:', error);
          return [];
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }
  
  // Get all chunks for a specific document name
  public async getChunksByDocumentName(documentName: string): Promise<SearchResult[]> {
    return this.fallbackService.withFallback(
      'getChunksByDocumentName',
      // Fallback function
      () => {
        // Get chunks from in-memory storage
        return Array.from(inMemoryDocuments.values())
          .filter(item => item.document.documentName === documentName)
          .map(item => {
            const doc = item.document;
            return {
              id: doc.id,
              documentName: doc.documentName,
              content: doc.content,
              enhancedContent: doc.enhancedContent,
              title: doc.title,
              summary: doc.summary,
              sourceFile: doc.sourceFile,
              domains: doc.domains,
              score: 1.0 // Not relevant for this query but needed for type
            };
          });
      },
      // Qdrant function
      async () => {
        const filter = {
          must: [
            {
              key: 'documentName',
              match: { 
                value: documentName
              }
            }
          ]
        };
        
        try {
          // Use scroll to get all chunks
          const chunks: SearchResult[] = [];
          let nextPageOffset: string | undefined;
          const limit = 100;
          
          do {
            const response = await this.qdrantClient.scroll(COLLECTION_NAME, {
              filter,
              with_payload: true,
              limit,
              offset: nextPageOffset,
            });
            
            const resultsPage = response.points.map(point => {
              const payload = point.payload as any;
              
              return {
                id: payload.id,
                documentName: payload.documentName,
                content: payload.content,
                enhancedContent: payload.enhancedContent,
                title: payload.title,
                summary: payload.summary,
                sourceFile: payload.sourceFile,
                domains: payload.domains || ['default'],
                score: 1.0 // Not relevant for this query but needed for type
              };
            });
            
            chunks.push(...resultsPage);
            nextPageOffset = response.next_page_offset as string | undefined;
          } while (nextPageOffset);
          
          return chunks;
        } catch (error) {
          console.error(`Error getting chunks for document ${documentName}:`, error);
          return [];
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }
  
  // Delete chunks by their IDs
  public async deleteChunksByIds(chunkIds: string[]): Promise<number> {
    return this.fallbackService.withFallback(
      'deleteChunksByIds',
      // Fallback function
      () => {
        let deletedCount = 0;
        
        // Delete each matching document
        for (const id of chunkIds) {
          if (inMemoryDocuments.has(id)) {
            inMemoryDocuments.delete(id);
            deletedCount++;
          }
        }
        
        console.log(`Deleted ${deletedCount} in-memory chunks`);
        return deletedCount;
      },
      // Qdrant function
      async () => {
        if (chunkIds.length === 0) return 0;
        
        try {
          // In Qdrant, we need to create a filter that matches these IDs
          const filter = {
            should: chunkIds.map(id => ({
              key: 'id',
              match: { value: id }
            }))
          };
          
          console.log(`Attempting to delete ${chunkIds.length} chunks`);
          
          // Count how many points match our filter
          const countResponse = await this.qdrantClient.count(COLLECTION_NAME, { filter });
          const pointCount = countResponse.count;
          
          if (pointCount === 0) {
            console.log('No matching chunks found to delete');
            return 0;
          }
          
          console.log(`Found ${pointCount} chunks to delete`);
          
          // Use the delete method with the filter
          await this.qdrantClient.delete(COLLECTION_NAME, {
            filter,
            wait: true
          });
          
          console.log(`Deleted ${pointCount} chunks`);
          return pointCount;
        } catch (error) {
          console.error('Error deleting chunks:', error);
          return 0;
        }
      },
      this.fallbackService.isFallbackActive()
    );
  }
} 