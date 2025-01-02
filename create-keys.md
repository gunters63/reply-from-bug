# Create certificates

Enter "localhost" every time you are asked for common name!

```sh
openssl genrsa -out rootCA.key 2048
openssl req -x509 -new -nodes -key rootCA.key -sha256 -days 1024 -out rootCA.pem
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr
openssl x509 -req -in server.csr -CA rootCA.pem -CAkey rootCA.key -CAcreateserial -out server.crt -days 500 -sha256

openssl x509 -in rootCA.pem -text -noout
openssl x509 -in server.crt -text -noout
```
