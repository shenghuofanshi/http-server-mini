import * as net from "net";
import * as fs from "fs";
import * as zlib from "zlib";

const NOT_FOUND = `HTTP/1.1 404 Not Found\r\n\r\n`;
const SUPPORT_COMPRESS_SCHEME = ["gzip"];

enum Endpoint {
  Echo = "/echo",
  UserAgent = "/user-agent",
  Default = "/",
  Files = "/files",
}

const buildResponse = (arg: Record<string, number | string | undefined>) => {
  const response: string[] = [];
  let bodyContext: string | boolean = false;
  for (const [key, value] of Object.entries(arg)) {
    if (key === "body") {
      if (value) {
        bodyContext = `\r\n${value}`;
      }
    } else {
      response.push(`${key} ${value}`);
    }
  }

  if (bodyContext) {
    response.push(bodyContext);
  }

  let joinedResponse = [...response, ""].join("\r\n");

  // joinedResponse += "\r\n\r\n";

  return joinedResponse;
};

const endpoints = {
  [Endpoint.Echo]: (data: Buffer): Record<string, number | string> => {
    const { params } = parseData(data);
    const echoParams = params.slice(Endpoint.Echo.length + 1);
    const responseSize = Buffer.byteLength(echoParams);

    return {
      "HTTP/1.1 200": "OK",
      "Content-Type:": "text/plain",
      "Content-Length:": responseSize,
      body: echoParams,
    };
  },
  [Endpoint.UserAgent]: (data: Buffer) => {
    const requestLines = data.toString().split("\r\n");
    const userAgentPrefix = "User-Agent: ";
    const userAgent = requestLines.find((line) =>
      line.startsWith(userAgentPrefix)
    );

    if (userAgent) {
      const agent = userAgent.slice(userAgentPrefix.length);
      const responseSize = Buffer.byteLength(agent);
      return {
        "HTTP/1.1 200": "OK",
        "Content-Type:": "text/plain",
        "Content-Length:": responseSize,
        body: agent,
      };
    }

    return {};
  },
  [Endpoint.Default]: (_arg: Buffer) => {
    return {
      "HTTP/1.1 200": "OK\r\n\r\n",
    };
  },
  [Endpoint.Files]: (data: Buffer): Record<string, number | string> => {
    const { params, method, body } = parseData(data);
    const fileName = params.slice(Endpoint.Files.length + 1);
    const args = process.argv.slice(2);
    const [___, absPath] = args;
    const filePath = `${absPath}/${fileName}`;

    try {
      if (method === "GET") {
        const content = fs.readFileSync(filePath);
        return {
          "HTTP/1.1 200": "OK",
          "Content-Type:": "application/octet-stream",
          "Content-Length:": content.length,
          body: `${content}`,
        };
      } else if (method === "POST") {
        fs.writeFileSync(filePath, body);
        return {
          "HTTP/1.1 201": "Created\r\n\r\n",
        };
      }
    } catch (err) {
      return {
        "HTTP/1.1 404": "Not Found\r\n\r\n",
      };
    }

    return {};
  },
};

const getEndPoint = (params: string): Endpoint | false => {
  const splitParams = params.split("/");
  const path = `/${splitParams[1]}`;
  return path in endpoints ? (path as Endpoint) : false;
};

const parseData = (data: Buffer) => {
  const [firstRequestLine, ...rest] = data.toString().split("\r\n");
  const [method, params, _protocol] = firstRequestLine.split(" ");
  const body = rest[rest.length - 1];

  return {
    body,
    method,
    params,
    rest,
  };
};

const writeResponse = (socket: net.Socket, httpResponse: string) => {
  socket.write(Buffer.from(httpResponse));
};

const server = net.createServer((socket) => {
  socket.on("data", (data: Buffer) => {
    const { params, rest } = parseData(data);
    const endpoint = getEndPoint(params);
    const aEncodingType = rest
      .find((headers) => headers.startsWith("Accept-Encoding: "))
      ?.slice("Accept-Encoding: ".length)
      ?.split(", ");

    let isValidContentEncoding = false;
    let encodingType: boolean | string = false;

    if (aEncodingType) {
      const search = SUPPORT_COMPRESS_SCHEME.find((supportedEncoding) => {
        const result = aEncodingType.includes(supportedEncoding);
        if (result) {
          encodingType = supportedEncoding;
        }
        return result;
      });
      isValidContentEncoding = Boolean(search);
    }

    let compressedBody: boolean | Buffer = false;
    if (endpoint) {
      let responseObject = endpoints[endpoint](data);
      if (isValidContentEncoding && encodingType) {
        const buffer = Buffer.from((responseObject as any).body, "utf8");
        compressedBody = zlib.gzipSync(buffer);

        const { body, ...rest } = {
          ...responseObject,
          "Content-Encoding:": encodingType,
          "Content-Length:": compressedBody.length,
        } as Record<any, any>;
        responseObject = rest;
      } else if (encodingType && !isValidContentEncoding) {
        const {
          body,
          ["Content-Length"]: contentLength,
          ["Content-Encoding:"]: contentEncoding,
          ...rest
        } = responseObject as Record<any, any>;
        responseObject = rest;
      }

      let response = buildResponse(responseObject);
      if (response.slice(-2) !== "\r\n") {
        response += "\r\n\r\n";
      } else if (response.slice(-4) !== "\r\n\r\n") {
        response += "\r\n";
      }
      writeResponse(socket, response);
      if (isValidContentEncoding && encodingType && compressedBody) {
        socket.write(Buffer.from(compressedBody));
      }
    } else {
      writeResponse(socket, NOT_FOUND);
    }
  });
});

server.listen(4221, "localhost", () => {
  console.log("Server is running on port 4221");
});
