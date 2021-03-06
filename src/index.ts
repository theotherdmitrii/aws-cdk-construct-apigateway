import * as apigateway from '@aws-cdk/aws-apigateway';
import {
  AuthorizationType,
  CorsOptions,
  HttpIntegration,
  HttpIntegrationProps,
  IResource,
  LambdaIntegrationOptions,
  MethodOptions,
  Model,
  PassthroughBehavior
} from '@aws-cdk/aws-apigateway';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cdk from '@aws-cdk/core';
import {Construct} from '@aws-cdk/core';

// Allowed headers
// const CORS_DEFAULT_ALLOW_HEADERS = [
//     'Content-Type', 'X-Amz-Date', 'Authorization', 'X-Api-Key', 'X-Amz-Security-Token'
// ].join(',');

export interface ApiGatewayWithHandlerProps {
  id: string;
}

export class NotFoundError extends Error {
}

/**
 * Construct to build and configure API Gateway
 *
 */
export class ApiGatewayConstruct extends Construct {

  private readonly api: apigateway.RestApi;

  private readonly resourceBuilders: { [key: string]: ApiResourceBuilder };

  readonly scope: Construct;

  constructor(scope: cdk.Construct, props: ApiGatewayWithHandlerProps) {

    super(scope, props.id);

    // ApiGateway instance
    this.api = new apigateway.RestApi(this, props.id);
    this.scope = scope;
    this.resourceBuilders = {};
  }

  public get url(): string {
    return this.api.url;
  }

  /**
   * Creates or or simply returns specified resource
   *
   * @param path
   * @param resourceBuilder
   */
  public resource(path: string,
                  resourceBuilder: (path: string) => ApiResourceBuilder = this.defaultResourceProvider.bind(this)
  ): ApiResourceBuilder {

    // Returns the root if path is just '/'
    if (path === '/') {
      return this.root();
    }

    if (!(path in this.resourceBuilders)) {
      resourceBuilder(path);
    }

    return this.resourceBuilders[path];
  }

  public resourceUrl(path: string) {
    if (!(path in this.resourceBuilders)) {
      throw new NotFoundError(`Fail to find resource with path ${path}`);
    }
    return this.api.urlForPath(path);
  }

  /**
   * Returns root resource
   */
  public root(): ApiResourceBuilder {
    return this.resourceBuilders['/'] = new ApiResourceBuilder(this, this.api.root);
  }

  // should be an arrow function
  private defaultResourceProvider(path: string): ApiResourceBuilder {
    let parent = this.api.root;
    let builder: ApiResourceBuilder;

    for (const segment of path.split('/')) {

      if (segment) {
        const basePath = path.substring(0, path.indexOf(segment));
        const resourcePath = basePath + segment;
        builder = this.resourceBuilders[resourcePath];

        // Adds new resource when builder not found
        if (!builder) {
          builder = new ApiResourceBuilder(this, parent.addResource(segment));
          this.resourceBuilders[resourcePath] = builder;
        }
        parent = builder.resource;
      }
    }

    return builder!!;
  }
}

export class ApiResourceBuilder {

  public get handlerName(): string | undefined {
    return (this.handler && this.handler.functionName) || undefined;
  }

  public get handlerArn(): string | undefined {
    return (this.handler && this.handler.functionArn) || undefined;
  }

  private handler: lambda.Function | undefined;

  constructor(private apiGatewayBuilder: ApiGatewayConstruct,
              public resource: IResource) {
  }

  /**
   * Returns instance of API Gateway Construct for the resource. It is useful
   * when to have fluent API where you can chain multiple method calls to build the API in form of
   *
   *
   */
  public build(): ApiGatewayConstruct {
    return this.apiGatewayBuilder;
  }

  public respond200(httpMethod: string): ApiResourceBuilder {
    const mockIntegration = new apigateway.MockIntegration({
      passthroughBehavior: PassthroughBehavior.NEVER,
      requestTemplates: {
        'application/json': '{"statusCode": 200}'
      },
      integrationResponses: [{
        statusCode: '200',
        responseParameters: {},
        responseTemplates: {
          'application/json': ''
        }
      }],
    });

    const method: MethodOptions = {
      methodResponses: [{
        statusCode: '200',
        responseModels: {
          'application/json': Model.EMPTY_MODEL
        },
        responseParameters: {}
      }]
    };

    this.resource.addMethod(httpMethod, mockIntegration, method);
    return this;
  }

  public respondOk(httpMethod: string): ApiResourceBuilder {
    return this.respond200(httpMethod);
  }

  /**
   * Adds lambda PROXY integration to current API Gateway
   *
   * @param httpMethod
   * @param handlerProps
   * @param options
   */
  public proxyLambda(httpMethod: string,
                     handlerProps: lambda.FunctionProps,
                     options?: LambdaIntegrationOptions): ApiResourceBuilder {

    const integrationProps: LambdaIntegrationOptions = {
      // True is the default value, just to be explicit
      proxy: true,
      // Overrides
      ...options,
    };

    // Memorizing the handler

    // Queue handler
    this.handler = new lambda.Function(this.apiGatewayBuilder.scope, 'QueueHandler', handlerProps);

    // Adding method
    this.resource.addMethod(httpMethod, new apigateway.LambdaIntegration(this.handler, integrationProps));
    return this;
  }

  /**
   * Adds HTTP proxy integration to API Gateway
   *
   * @param httpMethod
   * @param url
   * @param integrationProps
   * @param methodProps
   */
  public proxyHttp(httpMethod: string,
                   url: string, integrationProps?: HttpIntegrationProps,
                   methodProps?: MethodOptions): ApiResourceBuilder {
    //
    const method: MethodOptions = {
      authorizationType: AuthorizationType.NONE,
      // requestParameters: {
      //   'method.request.path.proxy': true
      // },
      // methodResponses: [{
      //   statusCode: '200'
      // }],
      // Overrides
      ...methodProps
    };

    const integration: HttpIntegration = new HttpIntegration(url, {
      options: {
        passthroughBehavior: PassthroughBehavior.WHEN_NO_MATCH,
        // requestParameters: {
        //   'integration.request.path.proxy': 'method.request.path.proxy',
        // },
        // integrationResponses: [{
        //   statusCode: '200'
        // }]
      },
      proxy: true,
      // Overrides
      httpMethod,
      ...integrationProps
    });
    this.resource.addMethod(httpMethod, integration, method);
    return this;
  }

  /**
   * Configures CORS policies for current resource
   *
   * @param props
   */
  public addCors(props: CorsOptions): ApiResourceBuilder {
    // const {
    //     allowOrigins, allowMethods, allowHeaders
    // } = props;
    //
    // const localAllowMethods: string[] = ['OPTIONS'].concat(allowMethods!!);
    // const mockIntegration = new apigateway.MockIntegration({
    //     passthroughBehavior: PassthroughBehavior.NEVER,
    //     requestTemplates: {
    //         'application/json': '{"statusCode": 200}'
    //     },
    //     integrationResponses: [{
    //         statusCode: '200',
    //         responseParameters: {
    //             'method.response.header.Access-Control-Allow-Headers': `\'${allowHeaders || CORS_DEFAULT_ALLOW_HEADERS}\'`,
    //             'method.response.header.Access-Control-Allow-Methods': `\'${localAllowMethods.join(',')}\'`,
    //             'method.response.header.Access-Control-Allow-Origin': `\'${origin}\'`,
    //         },
    //         responseTemplates: {
    //             'application/json': ''
    //         }
    //     }],
    // });
    //
    // const method: MethodOptions = {
    //     methodResponses: [{
    //         statusCode: '200',
    //         responseModels: {
    //             'application/json': new apigateway.EmptyModel()
    //         },
    //         responseParameters: {
    //             'method.response.header.Access-Control-Allow-Headers': false,
    //             'method.response.header.Access-Control-Allow-Methods': false,
    //             'method.response.header.Access-Control-Allow-Origin': false,
    //         }
    //     }]
    // };
    // // Instruments OPTION http method to return CORS policies
    // this.resource.addMethod('OPTIONS', mockIntegration, method);

    this.resource.addCorsPreflight(props);
    return this;
  }
}

