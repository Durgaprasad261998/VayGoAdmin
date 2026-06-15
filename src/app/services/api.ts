// api.service.ts
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import { Observable } from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ApiService {

  private baseUrl = environment.baseUrl;

  constructor(private http: HttpClient) {}

  // Common headers (optional)
  private getHeaders() {
    return new HttpHeaders({
      'Content-Type': 'application/json'
      // 'Authorization': 'Bearer token' (if needed)
    });
  }

  // GET
  get(endpoint: string, params?: any): Observable<any> {
    return this.http.get(`${this.baseUrl}/${endpoint}`, {
      headers: this.getHeaders(),
      params
    });
  }

  // POST
  post(endpoint: string, body: any): Observable<any> {
    return this.http.post(`${this.baseUrl}/${endpoint}`, body, {
      headers: this.getHeaders()
    });
  }

  // PUT
  put(endpoint: string, body: any): Observable<any> {
    return this.http.put(`${this.baseUrl}/${endpoint}`, body, {
      headers: this.getHeaders()
    });
  }

  // DELETE
  delete(endpoint: string): Observable<any> {
    return this.http.delete(`${this.baseUrl}/${endpoint}`, {
      headers: this.getHeaders()
    });
  }
}
