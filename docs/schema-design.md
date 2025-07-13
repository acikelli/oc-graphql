# Schema Design Guide

OC-GraphQL extends GraphQL with powerful custom directives that enable automatic CRUD generation, advanced SQL querying, and sophisticated resolver patterns. This guide covers schema design patterns and best practices.

## 🎯 Schema Design Philosophy

### Core Principles

1. **Convention over Configuration**: Automatic CRUD operations for standard entities
2. **SQL-First Analytics**: Direct SQL queries for complex analytics
3. **Type Safety**: Full GraphQL type checking and validation
4. **Scalable Relations**: Virtual tables for many-to-many relationships
5. **Performance Optimization**: Automatic partitioning and indexing

## 📋 Custom Directives

### 1. `@sql_query` - Direct SQL Integration

Execute SQL queries directly within GraphQL resolvers.

```graphql
directive @sql_query(query: String!) on FIELD_DEFINITION
```

#### Usage Examples

##### Basic Entity Queries

```graphql
type Query {
  # Simple data retrieval
  getUsersByCity(city: String!): [User!]!
    @sql_query(query: "SELECT * FROM user WHERE city = $args.city")

  # Aggregated analytics
  getUserStats: UserStats!
    @sql_query(query: "SELECT COUNT(*) as total, AVG(age) as avgAge FROM user")
}
```

##### Advanced Analytics Queries

```graphql
type Query {
  # Complex joins with date filtering
  getPopularPosts(days: Int = 7): [PostAnalytics!]!
    @sql_query(
      query: """
      SELECT
        p.id, p.title,
        COUNT(pl.id) as likes,
        COUNT(DISTINCT c.id) as comments
      FROM post p
      LEFT JOIN post_likes pl ON p.id = pl.post_id
      LEFT JOIN comment c ON p.id = c.post_id
      WHERE p.year = '2024'
        AND p.month = '12'
        AND p.created_at >= current_date - interval '$args.days' day
      GROUP BY p.id, p.title
      ORDER BY likes DESC
      LIMIT $args.limit
      """
    )
}
```

### 2. `@resolver` - Custom Resolver Types

Define types that are resolved through custom SQL logic rather than DynamoDB.

```graphql
directive @resolver on OBJECT
```

#### Usage Examples

##### Connection/Pagination Types

```graphql
type UserPostConnection @resolver {
  items: [Post!]!
    @sql_query(
      query: """
      SELECT * FROM post
      WHERE user_id = $source.id
      ORDER BY created_at DESC
      LIMIT $args.limit
      OFFSET $args.offset
      """
    )

  totalCount: Int!
    @sql_query(
      query: """
      SELECT COUNT(*) as count FROM post WHERE user_id = $source.id
      """
    )

  hasMore: Boolean! @return(value: "$args.offset + $args.limit < totalCount")
}
```

##### Analytics Aggregation Types

```graphql
type UserAnalytics @resolver {
  totalPosts: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post WHERE user_id = $source.id"
    )

  totalLikes: Int!
    @sql_query(
      query: """
      SELECT COUNT(*) as count FROM post_likes pl
      JOIN post p ON pl.post_id = p.id
      WHERE p.user_id = $source.id
      """
    )

  avgPostLength: Float!
    @sql_query(
      query: """
      SELECT AVG(LENGTH(content)) as avg_length
      FROM post WHERE user_id = $source.id
      """
    )

  joinedDate: String! @return(value: "$source.createdAt")
}
```

### 3. `@return` - Static Value Returns

Return computed or static values without database queries.

```graphql
directive @return(value: String!) on FIELD_DEFINITION
```

#### Usage Examples

##### Computed Values

```graphql
type UserPostConnection @resolver {
  # Calculate pagination metadata
  pageInfo: PageInfo!
    @return(value: "{hasNextPage: $args.offset + $args.limit < totalCount}")

  # Return request parameters
  currentOffset: Int! @return(value: "$args.offset")
  currentLimit: Int! @return(value: "$args.limit")

  # Static metadata
  queryTimestamp: String! @return(value: "new Date().toISOString()")
}
```

##### Parameter Passthrough

```graphql
type SearchResult @resolver {
  results: [Post!]!
    @sql_query(query: "SELECT * FROM post WHERE title ILIKE '%$args.query%'")

  # Return search parameters
  searchQuery: String! @return(value: "$args.query")
  searchFilters: String! @return(value: "$args.filters")
}
```

## 🏗️ Schema Structure Patterns

### Entity Types (Auto-CRUD)

Regular GraphQL types that automatically generate CRUD operations.

```graphql
type User {
  id: ID!
  email: String!
  name: String!
  age: Int
  city: String
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!

  # Field-level SQL queries (resolved via Lambda)
  totalPosts: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post WHERE user_id = $source.id"
    )

  # Relationship to resolver type
  posts(limit: Int = 10, offset: Int = 0): UserPostConnection!
  analytics: UserAnalytics!
}

type Post {
  id: ID!
  title: String!
  content: String!
  userId: ID!
  published: Boolean!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!

  # Field-level analytics
  likeCount: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post_likes WHERE post_id = $source.id"
    )
  commentCount: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM comment WHERE post_id = $source.id"
    )
}
```

### Resolver Types (Custom Logic)

Types resolved through SQL queries rather than DynamoDB lookups.

```graphql
type UserPostConnection @resolver {
  items: [Post!]!
    @sql_query(
      query: """
      SELECT * FROM post
      WHERE user_id = $source.id
      AND ($args.published IS NULL OR published = $args.published)
      ORDER BY created_at DESC
      LIMIT $args.limit OFFSET $args.offset
      """
    )

  totalCount: Int!
    @sql_query(
      query: """
      SELECT COUNT(*) as count FROM post
      WHERE user_id = $source.id
      AND ($args.published IS NULL OR published = $args.published)
      """
    )

  pageInfo: PageInfo!
    @return(value: "{hasNextPage: $args.offset + $args.limit < totalCount}")
}

type PostAnalytics @resolver {
  viewCount: Int!
    @sql_query(
      query: "SELECT view_count FROM post_views WHERE post_id = $source.id"
    )

  topCommenters: [User!]!
    @sql_query(
      query: """
      SELECT DISTINCT u.* FROM user u
      JOIN comment c ON u.id = c.user_id
      WHERE c.post_id = $source.id
      ORDER BY u.name
      LIMIT 5
      """
    )

  engagementScore: Float!
    @sql_query(
      query: """
      SELECT (
        COUNT(DISTINCT l.id) * 2 +
        COUNT(DISTINCT c.id) * 3 +
        COUNT(DISTINCT s.id) * 5
      ) / GREATEST(EXTRACT(days FROM NOW() - p.created_at), 1) as score
      FROM post p
      LEFT JOIN post_likes l ON p.id = l.post_id
      LEFT JOIN comment c ON p.id = c.post_id
      LEFT JOIN post_shares s ON p.id = s.post_id
      WHERE p.id = $source.id
      GROUP BY p.id, p.created_at
      """
    )
}
```

## 🔗 Virtual Tables (Many-to-Many Relationships)

Virtual tables handle complex relationships through SQL INSERT operations and automatic table generation.

### Virtual Table Patterns

#### User Favorites System

```graphql
type Mutation {
  # Creates entries in virtual table "user_favorites"
  addToFavorites(userId: ID!, productId: ID!): UserFavorite!
    @sql_query(
      query: "INSERT INTO $virtual_table(user_favorites) (user_id, product_id, created_at) VALUES ($args.userId, $args.productId, NOW())"
    )

  removeFromFavorites(userId: ID!, productId: ID!): Boolean!
    @sql_query(
      query: "DELETE FROM $virtual_table(user_favorites) WHERE user_id = $args.userId AND product_id = $args.productId"
    )
}

type Query {
  # Query virtual table data
  getUserFavorites(userId: ID!): [Product!]!
    @sql_query(
      query: """
      SELECT p.* FROM product p
      JOIN user_favorites uf ON p.id = uf.product_id
      WHERE uf.user_id = $args.userId
      ORDER BY uf.created_at DESC
      """
    )
}
```

#### Social Following System

```graphql
type Mutation {
  followUser(followerId: ID!, followingId: ID!): UserFollow!
    @sql_query(
      query: "INSERT INTO $virtual_table(user_follows) (follower_id, following_id, created_at) VALUES ($args.followerId, $args.followingId, NOW())"
    )

  unfollowUser(followerId: ID!, followingId: ID!): Boolean!
    @sql_query(
      query: "DELETE FROM $virtual_table(user_follows) WHERE follower_id = $args.followerId AND following_id = $args.followingId"
    )
}

type User {
  # Follower analytics
  followerCount: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM user_follows WHERE following_id = $source.id"
    )
  followingCount: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM user_follows WHERE follower_id = $source.id"
    )

  # Relationship queries
  followers(limit: Int = 10): [User!]!
    @sql_query(
      query: """
      SELECT u.* FROM user u
      JOIN user_follows uf ON u.id = uf.follower_id
      WHERE uf.following_id = $source.id
      LIMIT $args.limit
      """
    )

  following(limit: Int = 10): [User!]!
    @sql_query(
      query: """
      SELECT u.* FROM user u
      JOIN user_follows uf ON u.id = uf.following_id
      WHERE uf.follower_id = $source.id
      LIMIT $args.limit
      """
    )
}
```

## 📊 Parameter Handling

### Parameter Types

#### `$args` - GraphQL Arguments

Access field arguments in SQL queries.

```graphql
type Query {
  searchUsers(name: String!, city: String, minAge: Int): [User!]!
    @sql_query(
      query: """
      SELECT * FROM user
      WHERE name ILIKE '%$args.name%'
        AND ($args.city IS NULL OR city = $args.city)
        AND ($args.minAge IS NULL OR age >= $args.minAge)
      ORDER BY name
      """
    )
}
```

#### `$source` - Parent Object Data

Access parent object fields in nested resolvers.

```graphql
type User {
  recentPosts(days: Int = 7): [Post!]!
    @sql_query(
      query: """
      SELECT * FROM post
      WHERE user_id = $source.id
        AND created_at >= NOW() - INTERVAL '$args.days days'
      ORDER BY created_at DESC
      """
    )
}
```

### SQL Injection Protection

The system automatically escapes parameters to prevent SQL injection:

```javascript
// Automatic parameter sanitization
function escapeSqlValue(value) {
  if (typeof value === "string") {
    // Escape single quotes using SQL standard
    return "'" + value.split("'").join("''") + "'";
  } else if (typeof value === "number") {
    return value.toString();
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  // ... other type handling
}
```

## 🎨 Schema Best Practices

### 1. Entity Organization

```graphql
# Group related entities together
type User {
  # Core fields
  id: ID!
  email: String!

  # Computed fields (efficient SQL)
  postCount: Int!
    @sql_query(query: "SELECT COUNT(*) FROM post WHERE user_id = $source.id")

  # Complex relationships (resolver types)
  posts: UserPostConnection!
  analytics: UserAnalytics!
}
```

### 2. Performance Optimization

```graphql
# Use partition pruning in queries
type Query {
  getRecentPosts(days: Int = 7): [Post!]!
    @sql_query(
      query: """
      SELECT * FROM post
      WHERE year = '2024'
        AND month = '12'
        AND created_at >= current_date - interval '$args.days' day
      ORDER BY created_at DESC
      """
    )
}
```

### 3. Error Handling

```graphql
# Provide sensible defaults
type UserAnalytics @resolver {
  avgPostLength: Float!
    @sql_query(
      query: """
      SELECT COALESCE(AVG(LENGTH(content)), 0) as avg_length
      FROM post WHERE user_id = $source.id
      """
    )
}
```

### 4. Type Safety

```graphql
# Use proper GraphQL types
scalar AWSDateTime

type User {
  createdAt: AWSDateTime! # Automatic timestamp conversion
  age: Int # Optional vs required
  posts: [Post!]! # Non-null array of non-null posts
}
```

## 📋 Complete Schema Example

```graphql
# Entities (Auto-CRUD)
type User {
  id: ID!
  email: String!
  name: String!
  age: Int
  city: String
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!

  # Field resolvers
  postCount: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post WHERE user_id = $source.id"
    )

  # Relationships
  posts(
    limit: Int = 10
    offset: Int = 0
    published: Boolean
  ): UserPostConnection!
  analytics: UserAnalytics!
}

type Post {
  id: ID!
  title: String!
  content: String!
  userId: ID!
  published: Boolean!
  tags: [String!]
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!

  # Analytics
  likeCount: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post_likes WHERE post_id = $source.id"
    )
  viewCount: Int!
    @sql_query(
      query: "SELECT COALESCE(view_count, 0) FROM post_views WHERE post_id = $source.id"
    )
}

# Resolver Types
type UserPostConnection @resolver {
  items: [Post!]!
    @sql_query(
      query: """
      SELECT * FROM post
      WHERE user_id = $source.id
      AND ($args.published IS NULL OR published = $args.published)
      ORDER BY created_at DESC
      LIMIT $args.limit OFFSET $args.offset
      """
    )

  totalCount: Int!
    @sql_query(
      query: """
      SELECT COUNT(*) as count FROM post
      WHERE user_id = $source.id
      AND ($args.published IS NULL OR published = $args.published)
      """
    )

  hasMore: Boolean! @return(value: "$args.offset + $args.limit < totalCount")
}

type UserAnalytics @resolver {
  totalPosts: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post WHERE user_id = $source.id"
    )
  totalLikes: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post_likes pl JOIN post p ON pl.post_id = p.id WHERE p.user_id = $source.id"
    )
  avgEngagement: Float!
    @sql_query(
      query: "SELECT AVG(like_count + comment_count) FROM post_stats WHERE user_id = $source.id"
    )
  topTags: [String!]!
    @sql_query(
      query: "SELECT tag FROM post_tags pt JOIN post p ON pt.post_id = p.id WHERE p.user_id = $source.id GROUP BY tag ORDER BY COUNT(*) DESC LIMIT 5"
    )
}

# Queries
type Query {
  # Auto-generated CRUD
  readUser(id: ID!): User

  # Custom analytics
  getPopularPosts(days: Int = 7, limit: Int = 10): [Post!]!
    @sql_query(
      query: """
      SELECT p.*, COUNT(pl.id) as like_count
      FROM post p
      LEFT JOIN post_likes pl ON p.id = pl.post_id
      WHERE p.year = '2024' AND p.published = true
        AND p.created_at >= current_date - interval '$args.days' day
      GROUP BY p.id
      ORDER BY like_count DESC
      LIMIT $args.limit
      """
    )

  searchUsers(query: String!, city: String): [User!]!
    @sql_query(
      query: """
      SELECT * FROM user
      WHERE name ILIKE '%$args.query%'
        AND ($args.city IS NULL OR city = $args.city)
      ORDER BY name
      """
    )
}

# Mutations
type Mutation {
  # Auto-generated CRUD
  createUser(input: CreateUserInput!): User!
  updateUser(id: ID!, input: UpdateUserInput!): User!
  deleteUser(id: ID!): DeleteResult!

  # Virtual table operations
  likePost(userId: ID!, postId: ID!): PostLike!
    @sql_query(
      query: "INSERT INTO $virtual_table(post_likes) (user_id, post_id, created_at) VALUES ($args.userId, $args.postId, NOW())"
    )

  unlikePost(userId: ID!, postId: ID!): Boolean!
    @sql_query(
      query: "DELETE FROM $virtual_table(post_likes) WHERE user_id = $args.userId AND post_id = $args.postId"
    )
}
```

This schema design approach provides maximum flexibility while maintaining type safety and performance optimization through the OC-GraphQL code generation system.
